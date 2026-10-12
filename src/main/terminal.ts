// Runs a command in a visible system terminal window and waits for it to exit.
// Used for ACP terminal auth methods, which may be interactive.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Resolves with the command's exit code, or null if it could not be determined. */
export type TerminalRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => Promise<number | null>

export const runInTerminal: TerminalRunner = (command, args, env) =>
  process.platform === 'win32'
    ? runWindows(command, args, env)
    : runPosix(command, args, env)

function runWindows(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  // cmd.exe is a console program, so a detached cmd gets its own console window;
  // the command inherits it. Build the command line by hand (verbatim) so cmd's
  // quoting rules apply rather than Node's.
  const parts = [command, ...args]
  if (parts.some((p) => p.includes('"'))) {
    return Promise.reject(new Error('Sign-in command contains a double quote.'))
  }
  const line = parts.map((p) => `"${p}"`).join(' ')
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}

const TERMINAL_TIMEOUT_MS = 15 * 60 * 1000

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Best effort on macOS and Linux (not yet tested there). The terminal app does
// not inherit our environment or report the exit code, so a script exports the
// variables the agent needs and writes its exit code to a file we poll.
async function runPosix(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<number | null> {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-signin-'))
  const script = join(dir, 'signin.command')
  const exitFile = join(dir, 'exit-code')
  const exports = Object.entries(env)
    .filter(([k, v]) => v !== undefined && process.env[k] !== v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${shellQuote(v!)}`)
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      ...exports,
      [command, ...args].map(shellQuote).join(' '),
      `echo $? > ${shellQuote(exitFile)}`
    ].join('\n') + '\n'
  )
  chmodSync(script, 0o755)

  try {
    await openTerminal(script)
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (existsSync(exitFile)) {
        const code = Number.parseInt(readFileSync(exitFile, 'utf8').trim(), 10)
        return Number.isNaN(code) ? null : code
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function openTerminal(script: string): Promise<void> {
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['open', ['-a', 'Terminal', script]]]
      : [
          ['x-terminal-emulator', ['-e', script]],
          ['gnome-terminal', ['--', script]],
          ['konsole', ['-e', script]],
          ['xterm', ['-e', script]]
        ]
  for (const [cmd, args] of candidates) {
    const started = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    })
    if (started) return
  }
  throw new Error('Could not open a terminal window for sign-in.')
}
