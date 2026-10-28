import { spawn, execFile } from 'node:child_process'
import type { ShellResult } from '../shared/composer'

/** A user-entered shell command, executed directly with bounded captured output. */
export function runComposerShell(cwd: string, command: string, signal: AbortSignal, timeoutMs = 5 * 60 * 1000): Promise<ShellResult> {
  if (!command.trim() || command.length > 32000) return Promise.reject(new Error('Enter a shell command shorter than 32,000 characters.'))
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const shell = windows ? 'powershell.exe' : process.env.SHELL || '/bin/sh'
    const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command]
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(shell, args, { cwd, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let size = 0
    let truncated = false
    let timedOut = false
    const capture = (chunk: string): void => {
      const available = 900 * 1024 - size
      const data = Buffer.from(chunk)
      if (data.length > available) truncated = true
      if (available > 0) { output += data.subarray(0, available).toString('utf8'); size += Math.min(data.length, available) }
    }
    child.stdout.setEncoding('utf8').on('data', capture)
    child.stderr.setEncoding('utf8').on('data', capture)
    const stop = (): void => {
      if (!child.pid || child.exitCode !== null) return
      if (windows) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', stop) }
    child.once('error', (error) => { cleanup(); reject(new Error(`Could not start shell: ${error.message}`)) })
    child.once('close', (exitCode) => {
      cleanup()
      if (truncated) output += '\n[Output truncated at 900 KB]'
      if (timedOut) output += `\n[Stopped after ${Math.round(timeoutMs / 60000)} minutes]`
      else if (signal.aborted) output += '\n[Cancelled]'
      resolve({ command, output, exitCode, truncated })
    })
  })
}
