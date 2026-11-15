// New project and the projects folder (SPEC → Projects and sessions → New project).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where new projects and clones go: the setting, else the Desktop folder. */
export function projectsFolder(setting: string | undefined): string {
  return setting?.trim() || join(homedir(), 'Desktop')
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Checks a new project's folder name; returns why it can't be used, or null. One folder name
 * only (a phone may send it, so no separators or `..`), and one Windows accepts.
 */
export function projectNameError(name: string): string | null {
  if (name.trim() === '') return 'Enter a name.'
  if (name !== name.trim()) return "A name can't start or end with a space."
  if (name.length > 100) return 'Use a shorter name.'
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return 'A name can\'t contain < > : " / \\ | ? or *.'
  if (name === '.' || name === '..' || name.endsWith('.')) return "A name can't end with a dot."
  if (RESERVED.test(name)) return `${name} is reserved by Windows.`
  return null
}

function gitInit(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['init'], { cwd: dir, timeout: 30000, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve()
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('A new project needs Git on the PATH.'))
      reject(new Error(stderr.trim() || err.message))
    })
  })
}

/** Makes `<parent>/<name>` and runs `git init` there; resolves to the folder. An existing folder is an error. */
export async function createProject(parent: string, name: string): Promise<string> {
  const error = projectNameError(name)
  if (error) throw new Error(error)
  const dest = join(parent, name)
  if (existsSync(dest)) throw new Error(`${dest} already exists.`)
  mkdirSync(dest, { recursive: true })
  try {
    await gitInit(dest)
  } catch (err) {
    rmSync(dest, { recursive: true, force: true })
    throw err
  }
  return dest
}
