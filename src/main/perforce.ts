import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { DiffFile, ReviewDiff, ReviewRefs } from '../shared/review'
import { perforceLabel, perforceRange, perforceRef, type PerforceWorkspace } from '../shared/perforce'
import { parseDiff } from './review'

type RecordData = Record<string, string | number>
const LIMIT = 1024 * 1024
const READ_COMMANDS = new Set(['info', 'where', 'login', 'opened', 'status', 'changes', 'change', 'fstat', 'print', 'ignores', 'set'])
export class PerforceError extends Error {
  constructor(readonly kind: 'missing' | 'login' | 'expired' | 'unavailable' | 'unmapped' | 'failed', message: string) { super(message) }
}
export function parsePerforceRecords(output: string): RecordData[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RecordData)
}
/** Tagged output preserves ANSI bytes on non-Unicode servers; -Mj replaces them. */
export function parseTaggedRecords(output: string): RecordData[] {
  const result: RecordData[] = []
  let record: RecordData = {}
  let lastKey = ''
  for (const line of output.split(/\r?\n/)) {
    const tag = /^\.\.\. (\w+) ?(.*)$/.exec(line)
    if (tag) {
      if (tag[1] in record) { result.push(record); record = {} }
      record[tag[1]] = tag[2]
      lastKey = tag[1]
    } else if (line && lastKey) record[lastKey] = `${record[lastKey]}\n${line}`
    else if (!line && Object.keys(record).length) { result.push(record); record = {}; lastKey = '' }
  }
  if (Object.keys(record).length) result.push(record)
  return result
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
/** Escape literal filesystem paths before using them as Perforce file specifications. */
export function p4Path(path: string): string {
  if (path.includes('...')) throw new Error('Perforce paths cannot contain the recursive wildcard (...).')
  return path.replace(/%/g, '%25').replace(/#/g, '%23').replace(/@/g, '%40').replace(/\*/g, '%2A')
}

let ansiPage: Promise<string> | undefined
function ansiEncoding(): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('utf-8')
  return ansiPage ??= import('koffi').then((koffi) => {
    const page = Number(koffi.load('kernel32.dll').func('unsigned int __stdcall GetACP()')())
    return page === 65001 ? 'utf-8' : page === 932 ? 'shift_jis' : page === 936 ? 'gbk' : page === 949 ? 'euc-kr' : page === 950 ? 'big5' : `windows-${page}`
  })
}
async function command(cwd: string, commandName: string, args: string[] = [], options: { paths?: string[]; unicode?: boolean; raw?: boolean } = {}): Promise<string> {
  if (!READ_COMMANDS.has(commandName) || (commandName === 'login' && args.join(' ') !== '-s') || (commandName === 'change' && args[0] !== '-o') || (commandName === 'status' && args.length)) throw new Error('Perforce command is not read-only.')
  if (commandName === 'set' && args.join(' ') !== '-q P4CONFIG') throw new Error('Only P4CONFIG may be queried.')
  let temporary: string | undefined
  try {
    const globals = ['-L', 'en', ...(options.raw ? [] : options.unicode ? ['-Mj', '-ztag'] : ['-ztag'])]
    // ignores is client-local and consumes native argv, unlike server commands. On
    // Windows, asking it to transcode argv to UTF-8 corrupts non-ASCII local names.
    if (commandName === 'ignores' && process.platform === 'win32') globals.push('-C', 'none')
    if (options.paths?.length) {
      if (options.paths.some((p) => /[\r\n\0]/.test(p))) throw new Error('This Perforce filename cannot be passed safely.')
      temporary = await mkdtemp(join(tmpdir(), 'gloss-p4-args-'))
      const file = join(temporary, 'paths')
      // Unicode servers require UTF-8 argument files on Windows. ASCII is safe on either server.
      if (commandName === 'ignores' || (!options.unicode && process.platform === 'win32' && options.paths.some((p) => Array.from(p).some((c) => c.charCodeAt(0) > 127)))) {
        // Native argv preserves the local Windows code page for non-Unicode servers.
        args = [...args, ...options.paths]
      } else {
        await writeFile(file, options.paths.join('\n') + '\n')
        globals.push('-x', file)
      }
    }
    const encoding = options.unicode && commandName !== 'ignores' ? 'utf-8' : await ansiEncoding()
    return await new Promise((done, reject) => {
      const child = execFile('p4', [...globals, commandName, ...args], {
        cwd, windowsHide: true, timeout: 10000, maxBuffer: 16 * LIMIT, encoding: 'buffer',
        env: { ...process.env, PWD: cwd, ...(options.unicode ? { P4CHARSET: 'utf8' } : {}) }
      }, (error, stdout, stderr) => {
        const decode = (b: Buffer): string => new TextDecoder(encoding).decode(b)
        const output = commandName === 'print' ? stdout.toString('utf8') : decode(stdout)
        let records: RecordData[] = []
        try { if (!options.raw) records = options.unicode ? parsePerforceRecords(output) : parseTaggedRecords(output) } catch { reject(new PerforceError('failed', 'Perforce returned invalid output. Check the client encoding.')); return }
        const failure = records.find((r) => Number(r.severity) >= 3)
        const result = options.raw ? output : records.map((r) => JSON.stringify(r)).join('\n')
        const emptySelection = ['opened', 'fstat', 'status'].includes(commandName) && /no (?:such )?files?|not opened/i.test(decode(stderr))
        if (!failure && (!error || emptySelection || (records.length > 0 && records.every((r) => Number(r.severity) <= 2)))) { done(result); return }
        const code = error && 'code' in error ? error.code : undefined
        if (code === 'ENOENT') { reject(new PerforceError('missing', 'Install the Perforce p4 CLI and make it available on PATH.')); return }
        const message = String(failure?.data ?? decode(stderr))
        if (/session has expired/i.test(message)) reject(new PerforceError('expired', 'Perforce login has expired. Run p4 login in this project folder.'))
        else if (Number(failure?.generic) === 36 || /password|log in|login/i.test(message)) reject(new PerforceError('login', 'Perforce login is required. Run p4 login in this project folder.'))
        else if (error?.killed || /connect|TCP|WSAE|timed out/i.test(message)) reject(new PerforceError('unavailable', 'Perforce server is unavailable. Check the server connection and try again.'))
        else if (/not under|not in client view|unknown.*client|client.*unknown/i.test(message)) reject(new PerforceError('unmapped', 'This folder is not mapped in the configured Perforce client. Check P4CLIENT and P4CONFIG.'))
        else reject(new PerforceError('failed', 'Perforce could not read this selection. Check its mapping, permissions and current changelist state.'))
      })
      child.stdin?.end()
    })
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
}
async function records(cwd: string, name: string, args: string[] = [], paths?: string[], unicode = false): Promise<RecordData[]> {
  return parsePerforceRecords(await command(cwd, name, args, { paths, unicode }))
}
/** Distinguish a configured but broken Perforce project from an ordinary folder. */
export async function hasPerforceConfig(cwd: string): Promise<boolean> {
  const output = await command(cwd, 'set', ['-q', 'P4CONFIG'], { raw: true }).catch(() => '')
  const effective = /^P4CONFIG=(.*?)\s*(?:\([^\n]*\))?$/m.exec(output)?.[1]?.trim()
  const name = effective || process.env.P4CONFIG || '.p4config'
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if ((await stat(join(dir, name)).catch(() => null))?.isFile()) return true
    if (dirname(dir) === dir) return false
  }
}
export async function perforceWorkspace(cwd: string): Promise<PerforceWorkspace> {
  let info = (await records(cwd, 'info'))[0]
  // The first call discovers the server mode. Re-read names in explicit UTF-8 before
  // validating paths, since a Unicode server may otherwise use a cached console charset.
  const unicode = info?.unicode === 'enabled'
  if (unicode) info = (await records(cwd, 'info', [], undefined, true))[0]
  if (!info?.clientRoot || !info.clientName || info.clientName === '*unknown*' || !inside(String(info.clientRoot), resolve(cwd))) throw new PerforceError('unmapped', 'This folder is not in a configured Perforce workspace. Check P4CLIENT and P4CONFIG.')
  const mapping = await records(cwd, 'where', [], [p4Path(resolve(cwd)) + '/...'], unicode)
  if (!mapping.some((r) => r.path && r.unmap === undefined)) throw new PerforceError('unmapped', 'This folder is excluded from the Perforce client view.')
  await records(cwd, 'login', ['-s'], undefined, unicode)
  return { client: String(info.clientName), root: String(info.clientRoot), user: String(info.userName ?? ''), server: String(info.serverAddress ?? ''), stream: info.clientStream ? String(info.clientStream) : undefined, unicode }
}
async function selected(cwd: string, ref: string): Promise<{ workspace: PerforceWorkspace; change: string }> {
  const range = perforceRange(ref)
  if (!range) throw new Error('Not a Perforce review.')
  const workspace = await perforceWorkspace(cwd)
  if (workspace.client !== range.client) throw new Error('The configured Perforce client changed. Restore it or start a new review.')
  if (!['workspace', 'default'].includes(range.change)) {
    const change = (await records(cwd, 'change', ['-o', range.change], undefined, workspace.unicode))[0]
    if (change?.Status !== 'pending' || change.Client !== workspace.client) throw new Error('This changelist is no longer pending in this client. Choose another range.')
  }
  return { workspace, change: range.change }
}
export async function perforceRefs(cwd: string, ref: string): Promise<ReviewRefs> {
  const workspace = await perforceWorkspace(cwd)
  const range = perforceRange(ref)
  if (range?.client !== workspace.client) throw new Error('The configured Perforce client changed.')
  const changes = await records(cwd, 'changes', ['-s', 'pending', '-c', workspace.client], undefined, workspace.unicode)
  const entries = ['workspace', 'default'].map((change) => ({ ref: perforceRef(workspace.client, change), label: perforceLabel(change) }))
  entries.push(...changes.map((r) => ({ ref: perforceRef(workspace.client, String(r.change)), label: `CL ${r.change}: ${String(r.desc).trim()}` })))
  return { bases: [], commits: [], repoUrl: null, defaultBase: entries[0].ref, perforce: { workspace, changes: entries } }
}
async function localText(path: string): Promise<string | null> {
  const details = await stat(path).catch(() => null)
  if (!details?.isFile() || details.size > LIMIT) return null
  const bytes = await readFile(path)
  if (bytes.length > LIMIT || bytes.subarray(0, 8000).includes(0)) return null
  return bytes.toString('utf8').replace(/\r\n/g, '\n')
}
export async function perforceFilePath(cwd: string, path: string, ref: string): Promise<string> {
  const { workspace } = await selected(cwd, ref)
  const absolute = resolve(workspace.root, path)
  if (!inside(workspace.root, absolute) || absolute === workspace.root) throw new Error('File is outside the workspace.')
  const mapping = await records(cwd, 'where', [], [p4Path(absolute)], workspace.unicode)
  if (!mapping.some((r) => r.path && r.unmap === undefined)) throw new Error('File is not mapped.')
  const actual = await realpath(absolute)
  if (!inside(await realpath(workspace.root), actual)) throw new Error('File points outside the workspace.')
  return actual
}
export async function perforceFile(cwd: string, path: string, ref: string): Promise<string[] | null> {
  const text = await localText(await perforceFilePath(cwd, path, ref))
  if (text === null) return null
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop()
  return lines
}
/** Paths per p4 command: a long list goes in several, so a native command line stays short. */
const BATCH = 100
/** p4 prints run at once while reading a diff. */
const PARALLEL = 8

async function batchedRecords(cwd: string, name: string, args: string[], paths: string[], unicode: boolean): Promise<RecordData[]> {
  const out: RecordData[] = []
  for (let i = 0; i < paths.length; i += BATCH) out.push(...(await records(cwd, name, args, paths.slice(i, i + BATCH), unicode)))
  return out
}

/** Runs `f` on each item, `PARALLEL` at a time; results in order. */
async function pooled<T, R>(items: T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await f(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
  return results
}

/** A mapped file's text in the workspace, like perforceFile's checks but with the mapping known. */
async function workspaceText(w: PerforceWorkspace, absolute: string): Promise<string | null> {
  if (!inside(w.root, absolute) || absolute === w.root) throw new Error('File is outside the workspace.')
  const actual = await realpath(absolute)
  if (!inside(await realpath(w.root), actual)) throw new Error('File points outside the workspace.')
  return localText(actual)
}

/**
 * The selected files' diff. Mappings and file types are read for all files at once and
 * base revisions a few at a time, so the number of p4 processes doesn't grow by several
 * per file (SPEC → Performance).
 */
export async function perforceDiff(cwd: string, ref: string): Promise<ReviewDiff> {
  const { workspace: w, change } = await selected(cwd, ref)
  const opened = await records(cwd, 'opened', change === 'workspace' ? [] : ['-c', change], undefined, w.unicode)
  const unopened = change === 'workspace' ? (await records(cwd, 'status', [], [p4Path(resolve(cwd)) + '/...'], w.unicode)).filter((r) => r.change === undefined && r.depotFile) : []
  const items = [...opened, ...unopened].filter((item) => item.depotFile && item.action !== 'move/delete')
  // Where each depot file (and a moved file's source) is in the workspace: its last mapping line wins.
  const depots = [...new Set(items.flatMap((item) => [String(item.depotFile), ...(item.action === 'move/add' && item.movedFile ? [String(item.movedFile)] : [])]))]
  const where = new Map<string, string>()
  for (const r of await batchedRecords(cwd, 'where', [], depots, w.unicode)) {
    if (r.depotFile && r.unmap === undefined && r.path) where.set(String(r.depotFile), String(r.path))
  }
  const typed = items.filter((item) => item.action !== 'add' && item.action !== 'branch').map((item) => String(item.depotFile))
  const meta = new Map<string, RecordData>()
  for (const r of await batchedRecords(cwd, 'fstat', ['-Ol'], typed, w.unicode)) if (r.depotFile && !meta.has(String(r.depotFile))) meta.set(String(r.depotFile), r)
  const files = await pooled(items, async (item): Promise<DiffFile | null> => {
    const depot = String(item.depotFile)
    const absolute = where.get(depot)
    if (!absolute || !inside(w.root, absolute)) return null
    const path = relative(w.root, absolute).split(sep).join('/')
    const action = String(item.action)
    const added = action === 'add' || action === 'branch'
    const deleted = action === 'delete'
    const moved = action === 'move/add'
    const info = added ? item : meta.get(depot) ?? item
    let oldPath: string | undefined
    const baseDepot = String(item.movedFile ?? depot)
    if (moved) {
      const source = where.get(baseDepot)
      if (source && inside(w.root, source)) oldPath = relative(w.root, source).split(sep).join('/')
    }
    const binary = /binary|resource|apple/.test(String(info.type ?? info.headType ?? item.type)) || Number(info.fileSize) > LIMIT
    let before: string | null = ''
    let after: string | null = ''
    if (!binary) {
      if (!added) before = (await command(cwd, 'print', ['-q'], { paths: [`${baseDepot}#have`], unicode: w.unicode, raw: true })).replace(/\r\n/g, '\n')
      if (!deleted) after = await workspaceText(w, absolute)
    }
    const unavailable = binary || before === null || after === null || before.length > LIMIT || before.slice(0, 8000).includes('\0')
    const parsed = unavailable ? undefined : parseDiff(`diff --git a/file b/file\n${createTwoFilesPatch('a/file', 'b/file', before, after ?? '', '', '', { context: 3 })}`)[0]
    return { path, oldPath, displayPath: inside(cwd, absolute) ? relative(cwd, absolute).split(sep).join('/') : path,
      outside: !inside(cwd, absolute), status: moved ? 'renamed' : added ? 'added' : deleted ? 'deleted' : 'modified',
      binary: unavailable, state: 'uncommitted', perforce: { opened: item.change !== undefined, change: item.change === undefined ? undefined : String(item.change) },
      additions: parsed?.additions ?? 0, deletions: parsed?.deletions ?? 0, hunks: parsed?.hunks ?? [] }
  })
  const shown = files.filter((f): f is DiffFile => f !== null)
  shown.sort((a, b) => Number(a.outside) - Number(b.outside) || a.path.localeCompare(b.path))
  return { baseRef: ref, base: ref, head: 'have', headRef: null, files: shown, perforce: { workspace: w, change, project: cwd } }
}
export async function perforceStatus(cwd: string): Promise<import('../shared/ipc').GitStatus> {
  try {
    const w = await perforceWorkspace(cwd)
    const opened = await records(cwd, 'opened', [], undefined, w.unicode)
    return { branch: w.stream ?? w.client, dirty: opened.length > 0, url: null, perforce: true, tooltip: `Client: ${w.client}\nUser: ${w.user}\nServer: ${w.server}\nRoot: ${w.root}` }
  } catch (error) {
    return { branch: error instanceof PerforceError && error.kind === 'expired' ? 'Login expired' : error instanceof PerforceError && error.kind === 'login' ? 'Login required' : 'Perforce unavailable', dirty: false, url: null, perforce: true, tooltip: error instanceof Error ? error.message : 'Perforce unavailable' }
  }
}

/** Only the supplied file paths are inspected, never a recursive status query. */
export async function perforceNotOpened(cwd: string, paths: string[]): Promise<number> {
  if (!paths.length) return 0
  const w = await perforceWorkspace(cwd)
  const candidates = [...new Set(paths.map((p) => resolve(cwd, p)))].filter((p) => inside(w.root, p) && p !== resolve(w.root))
  const targets: string[] = []
  for (const path of candidates) {
    const details = await lstat(path).catch(() => null)
    // Deleted files have no stat; directory locations must never trigger a recursive scan.
    if (!details || details.isFile()) targets.push(path)
  }
  if (!targets.length) return 0
  const result = await records(cwd, 'status', [], targets.map(p4Path), w.unicode)
  return new Set(result.filter((r) => r.depotFile && r.change === undefined).map((r) => String(r.depotFile))).size
}

/** P4 performs ignore matching; tracked files bypass ignore rules. No symlink traversal. */
export async function perforceContextPaths(cwd: string): Promise<string[]> {
  const w = await perforceWorkspace(cwd)
  const tracked = await records(cwd, 'fstat', [], [p4Path(resolve(cwd)) + '/...'], w.unicode)
  const known = new Set(tracked.filter((r) => r.clientFile && r.isMapped !== undefined).map((r) => resolve(String(r.clientFile))))
  const candidates: string[] = []
  async function ignoredPaths(paths: string[]): Promise<Set<string>> {
    const ignored = new Set<string>()
    for (let offset = 0; offset < paths.length; offset += 200) {
      const output = await command(cwd, 'ignores', ['-i'], { paths: paths.slice(offset, offset + 200), unicode: w.unicode, raw: true })
      for (const line of output.split(/\r?\n/).filter((s) => s.endsWith(' ignored'))) ignored.add(resolve(cwd, line.slice(0, -8)))
    }
    return ignored
  }
  let visited = 0
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12 || visited++ >= 1000 || candidates.length >= 20000) return
    const entries = await readdir(dir, { withFileTypes: true })
    const ignored = await ignoredPaths(entries.filter((e) => !known.has(join(dir, e.name))).map((e) => join(dir, e.name) + (e.isDirectory() ? '/' : '')))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (ignored.has(resolve(path))) continue
      if (entry.isFile()) candidates.push(path)
      else if (entry.isDirectory() && entry.name !== '.git') await walk(path, depth + 1)
      if (candidates.length >= 20000) break
    }
  }
  await walk(cwd, 0)
  for (const path of known) {
    if (!inside(cwd, path)) continue
    const actual = await realpath(path).catch(() => null)
    if (actual && inside(await realpath(cwd), actual) && (await lstat(path)).isFile()) candidates.push(path)
  }
  return [...new Set(candidates)].slice(0, 20000).map((p) => relative(cwd, p).split(sep).join('/'))
}
