import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
import { rmSync } from 'node:fs'
import { IPC } from '../shared/ipc'
import { runComposerShell } from './composerShell'
import type { ContextItem, ShellResult } from '../shared/composer'
import type { Attachment } from '../shared/types'
import type { Store } from './db'
import { attachPathContext, contextPaths, externalContextItems, gitOutput, pathContextItems, readContextText } from './composerContext'
import { draftEditorArgs, launchEditor } from './openFile'
import { toMarkdown } from './export'

export function registerComposerIpc(store: Store, isGloss: (sender: WebContents) => boolean, editor: () => string, returnToGloss: (sender: WebContents) => void): void {
  const shells = new Map<string, AbortController>()
  const terminals = new Map<string, ShellResult>()
  const drafts = new Set<string>()
  app.once('will-quit', () => {
    for (const shell of shells.values()) shell.abort()
    for (const dir of drafts) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* The editor may still hold the file open. */ } }
  })
  const cache = new Map<string, { at: number; paths: Promise<string[]> }>()
  const check = (sender: WebContents): void => { if (!isGloss(sender)) throw new Error('Only a Gloss window can use composer tools.') }
  const str = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Expected text.'); return value }
  const session = (id: unknown) => {
    const s = store.getSession(str(id))
    if (!s) throw new Error('Session no longer exists.')
    return s
  }
  ipcMain.handle(IPC.composerContexts, async (e, id: unknown, query: unknown) => {
    check(e.sender)
    const s = session(id)
    const raw = str(query)
    const q = raw.toLowerCase()
    if (q.length > 4096) return []
    const external = await externalContextItems(s.cwd, raw, homedir())
    if (external !== null) return external
    let cached = cache.get(s.cwd)
    if (!cached || Date.now() - cached.at > 5000) {
      if (cache.size > 20) cache.clear()
      cached = { at: Date.now(), paths: contextPaths(s.cwd) }
      cache.set(s.cwd, cached)
    }
    return cached.paths.then((paths) => {
      const special: ContextItem[] = [
        { kind: 'folder' as const, id: app.getPath('downloads').replace(/\\/g, '/'), label: 'Downloads/', description: 'Browse Downloads', browse: true },
        ...(terminals.has(s.id) ? [{ kind: 'terminal' as const, id: s.id, label: 'terminal', description: 'Last shell command and output in this session' }] : []),
        { kind: 'diff' as const, id: 'working', label: 'diff', description: 'Unstaged changes' },
        { kind: 'diff' as const, id: 'staged', label: 'staged', description: 'Staged changes' },
        ...store.listSessions().filter((other) => other.id !== s.id && !other.draft).slice(0, 100).map((other): ContextItem => ({ kind: 'chat', id: other.id, label: `chat:${other.title}`, description: 'Attach conversation transcript' }))
      ].filter((item) => item.label.toLowerCase().includes(q))
      return [...special.filter((item) => item.kind !== 'chat'), ...pathContextItems(paths, q), ...special.filter((item) => item.kind === 'chat')].slice(0, 12)
    })
  })
  ipcMain.handle(IPC.composerAttach, async (e, id: unknown, value: unknown): Promise<Attachment> => {
    check(e.sender)
    const s = session(id)
    if (!value || typeof value !== 'object') throw new Error('Choose context to attach.')
    const item = value as ContextItem
    str(item.id)
    str(item.label)
    if (item.kind === 'file' || item.kind === 'folder') return attachPathContext(s.cwd, item)
    if (item.kind === 'diff') {
      if (item.id !== 'working' && item.id !== 'staged') throw new Error('Unknown diff.')
      const text = await gitOutput(s.cwd, ['diff', '--no-ext-diff', '--no-textconv', ...(item.id === 'staged' ? ['--cached'] : []), '--', '.'])
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Diff exceeds 1 MB. Attach individual files instead.')
      return { kind: 'file', name: `${item.id}-changes.diff`, text: text || '(No changes)' }
    }
    if (item.kind === 'terminal') {
      const result = terminals.get(s.id)
      if (!result) throw new Error('Run a shell command in this session first.')
      return { kind: 'file', name: 'terminal-output.txt', text: `$ ${result.command}\nExit code: ${result.exitCode}\n\n${result.output}` }
    }
    if (item.kind === 'chat') {
      const other = session(item.id)
      const text = toMarkdown({ session: other, messages: store.listMessages(other.id), toolCalls: store.listToolCalls(other.id), threads: store.listThreads(other.id) }, null)
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Conversation exceeds 1 MB.')
      return { kind: 'file', name: `${other.title}.md`, text }
    }
    throw new Error('Unknown context type.')
  })
  ipcMain.handle(IPC.composerShell, async (e, id: unknown, value: unknown) => {
    check(e.sender)
    const s = session(id)
    if (shells.has(s.id)) throw new Error('A shell command is already running in this session.')
    const controller = new AbortController()
    shells.set(s.id, controller)
    try {
      const result = await runComposerShell(s.cwd, str(value), controller.signal)
      if (terminals.size >= 50) terminals.delete(terminals.keys().next().value!)
      terminals.set(s.id, result)
      return result
    } finally { shells.delete(s.id) }
  })
  ipcMain.handle(IPC.composerCancelShell, (e, id: unknown) => {
    check(e.sender)
    shells.get(session(id).id)?.abort()
  })
  ipcMain.handle(IPC.composerEditDraft, async (e, value: unknown) => {
    check(e.sender)
    const text = str(value)
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Draft exceeds 1 MB.')
    if (drafts.size >= 20) throw new Error('Too many editor drafts are already open.')
    const dir = await mkdtemp(join(tmpdir(), 'gloss-draft-'))
    drafts.add(dir)
    const file = join(dir, 'prompt.md')
    try {
      const args = draftEditorArgs(editor(), file)
      if (!args.length) throw new Error('Choose an external editor in Settings first.')
      await writeFile(file, text, { mode: 0o600 })
      await launchEditor(args, file, process.platform, true)
      return { text: await readContextText(file) }
    } finally {
      drafts.delete(dir)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      returnToGloss(e.sender)
    }
  })
}
