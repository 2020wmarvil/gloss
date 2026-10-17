// Opening a review's file outside Gloss (SPEC → Review sessions → Diff view): in the
// user's editor, from the External editor setting, or in the system's file manager.
import { spawn } from 'node:child_process'
import { allowForeground } from './foreground'

/** Splits a command line into arguments: spaces separate them, double quotes group. */
export function splitArgs(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const c of command) {
    if (c === '"') {
      quoted = !quoted
      started = true
    } else if (/\s/.test(c) && !quoted) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += c
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/**
 * The editor's arguments for a file: the setting's command with `{file}` and `{line}`
 * filled in, or with the file appended when it has no `{file}`. Empty for no command.
 */
export function editorArgs(command: string, file: string, line: number): string[] {
  const args = splitArgs(command.trim())
  if (args.length === 0) return []
  const filled = args.map((a) => a.split('{file}').join(file).split('{line}').join(String(line)))
  return args.some((a) => a.includes('{file}')) ? filled : [...filled, file]
}

/**
 * A cmd.exe command line for the arguments. cmd expands `%VAR%` even inside quotes and
 * has no escape for it there, so a file path with `%` or `"` is refused.
 */
export function windowsCommandLine(args: string[], file: string): string {
  if (/[%"]/.test(file)) throw new Error("Gloss can't pass a path containing % or \" to the editor command.")
  return args.map((a) => (a === '' || /[\s&|<>^()]/.test(a) ? `"${a}"` : a)).join(' ')
}

/**
 * Starts the editor and resolves once it is running (or its launcher has exited
 * cleanly). Rejects if it can't start or exits with an error straight away.
 */
export async function launchEditor(args: string[], file: string, platform = process.platform): Promise<void> {
  // An editor that is already running is handed the file: let it come to the front.
  await allowForeground(platform)
  // Gloss runs its agents as Node with this set; an Electron-based editor must not inherit it.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // On Windows editors are often .cmd launchers (code.cmd), which only run through a shell.
  const child =
    platform === 'win32'
      ? spawn(windowsCommandLine(args, file), { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env })
      : spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore', env })
  return new Promise((resolve, reject) => {
    const done = setTimeout(() => {
      child.unref()
      resolve()
    }, 1500)
    child.once('error', (err) => {
      clearTimeout(done)
      reject(new Error(`Couldn't start the editor (${args[0]}): ${err.message}`))
    })
    child.once('exit', (code) => {
      clearTimeout(done)
      if (code === 0 || code === null) resolve()
      else reject(new Error(`The editor command (${args[0]}) failed with exit code ${code}. Check External editor in Settings.`))
    })
  })
}
