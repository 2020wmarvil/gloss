import { execFile } from 'node:child_process'
import { open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Attachment } from '../shared/types'
import type { ContextItem } from '../shared/composer'
import { readMarkdownImage } from './markdownImage'

const MAX_BYTES = 1024 * 1024
const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build', '.venv', 'venv'])

/** Explicit local paths can browse beyond the project, one directory at a time. */
export async function externalContextItems(cwd: string, query: string, home: string): Promise<ContextItem[] | null> {
  let path = query.replace(/\\/g, '/')
  if (/^\/\//.test(path) || Array.from(path).some((c) => c.charCodeAt(0) < 32)) return []
  if (path === '~') path = `${home}/`
  else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`
  else if (/^[a-z]:$/i.test(path)) path += '/'
  else if (!isAbsolute(path) && !path.startsWith('../')) return null
  const browsing = path.endsWith('/')
  if (!isAbsolute(path)) path = resolve(cwd, path)
  const directory = browsing ? path : dirname(path)
  const prefix = browsing ? '' : basename(path).toLowerCase()
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const homePath = home.replace(/\\/g, '/').replace(/\/$/, '')
  return entries.filter((entry) => (entry.isFile() || entry.isDirectory()) && entry.name.toLowerCase().startsWith(prefix))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 50).map((entry) => {
      const target = join(directory, entry.name).replace(/\\/g, '/')
      const display = query.startsWith('~') && target.toLowerCase().startsWith(`${homePath.toLowerCase()}/`) ? `~/${target.slice(homePath.length + 1)}` : target
      return { kind: entry.isDirectory() ? 'folder' : 'file', id: target, label: `${display}${entry.isDirectory() ? '/' : ''}`,
        description: entry.isDirectory() ? 'Browse folder' : 'Attach file', ...(entry.isDirectory() ? { browse: true } : {}) }
    })
}

export function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, windowsHide: true, timeout: 10000, maxBuffer: 8 * MAX_BYTES }, (error, stdout) => {
    if (error) reject(new Error('Git context is unavailable. Check that this project is a Git repository.'))
    else resolve(stdout)
  }))
}

/** Git projects respect ignore rules. Other folders use a bounded traversal without symlinks. */
export async function contextPaths(cwd: string): Promise<string[]> {
  try {
    return [...new Set((await gitOutput(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'])).split('\0').filter(Boolean))].slice(0, 20000)
  } catch {
    const paths: string[] = []
    let visited = 0
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 12 || visited++ > 1000 || paths.length >= 20000) return
      for (const entry of await readdir(join(cwd, dir), { withFileTypes: true }).catch(() => [])) {
        if (paths.length >= 20000) break
        if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith('.')) await walk(join(dir, entry.name), depth + 1)
        else if (entry.isFile() && !entry.name.startsWith('.')) paths.push(join(dir, entry.name).split(sep).join('/'))
      }
    }
    await walk('', 0)
    return paths
  }
}

export function pathContextItems(paths: string[], query: string): ContextItem[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/') + '/')
  }
  const q = query.toLowerCase()
  return [
    ...paths.map((path): ContextItem => ({ kind: 'file', id: path, label: path, description: 'Attach file' })),
    ...[...folders].map((path): ContextItem => ({ kind: 'folder', id: path, label: path, description: 'Attach folder contents (up to 50 files / 1 MB)' }))
  ].filter((item) => item.label.toLowerCase().includes(q))
    .sort((a, b) => Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)) || a.label.localeCompare(b.label)).slice(0, 10)
}

async function projectPath(cwd: string, path: string): Promise<string> {
  if (/^[\\/]{2}/.test(path)) throw new Error('Choose a local path.')
  if (isAbsolute(path)) return realpath(path)
  const root = await realpath(cwd)
  const target = await realpath(join(root, path))
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('This path points outside the project.')
  return target
}

export async function readContextText(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Choose a text file smaller than 1 MB.')
    const data = Buffer.alloc(stat.size + 1)
    let bytesRead = 0
    while (bytesRead < data.length) {
      const result = await file.read(data, bytesRead, data.length - bytesRead, null)
      if (!result.bytesRead) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_BYTES) throw new Error('File exceeds 1 MB.')
    const text = data.subarray(0, bytesRead).toString('utf8')
    if (text.includes('\0') || text.includes('\uFFFD')) throw new Error('This file is not UTF-8 text.')
    return text
  } finally { await file.close() }
}

export async function attachPathContext(cwd: string, item: ContextItem): Promise<Attachment> {
  const path = await projectPath(cwd, item.id)
  if (isAbsolute(item.id) && item.kind !== 'file') throw new Error('Browse to a file to attach it.')
  if (item.kind === 'file') {
    if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
      const data = await readMarkdownImage(path)
      const comma = data.indexOf(',')
      if (Buffer.from(data.slice(comma + 1), 'base64').length > 10 * MAX_BYTES) throw new Error('Image exceeds the 10 MB attachment limit.')
      return { kind: 'image', name: basename(path), mimeType: data.slice(5, data.indexOf(';')), data: data.slice(comma + 1) }
    }
    return { kind: 'file', name: basename(path), path, text: await readContextText(path) }
  }
  const prefix = item.id.replace(/\/$/, '') + '/'
  const paths = (await contextPaths(cwd)).filter((p) => p.startsWith(prefix))
  if (paths.length > 50) throw new Error('Folder exceeds 50 files. Attach a smaller folder or individual files.')
  if (!paths.length) throw new Error('This folder has no attachable files.')
  const parts: string[] = []
  let size = 0
  for (const name of paths) {
    const text = await readContextText(await projectPath(cwd, name))
    const part = `## ${name}\n\n${text}`
    size += Buffer.byteLength(part)
    if (size > MAX_BYTES) throw new Error('Folder exceeds 1 MB. Attach a smaller folder or individual files.')
    parts.push(part)
  }
  return { kind: 'file', name: item.label, text: parts.join('\n\n') }
}
