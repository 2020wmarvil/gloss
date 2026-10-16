import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { IPC, type GlossEvent } from '../shared/ipc'
import type { Anchor, Attachment } from '../shared/types'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig, listAgents } from './agents'
import { Store } from './db'
import type { SearchRequest } from '../shared/search'
import { toMarkdown } from './export'
import { gitStatus, pullRequest } from './git'
import { SessionManager } from './sessions'
import { patchArg, SettingsFile } from './settings'
import { editorArgs, launchEditor } from './openFile'
import { runInTerminal } from './terminal'
import { UsageSource } from './usage'
import { previewMcpImport } from './mcp-import'

let mainWindow: BrowserWindow | undefined
let store: Store | undefined
let sessions: SessionManager | undefined
let settings: SettingsFile | undefined
const usage = new UsageSource()

function isExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    title: 'Gloss',
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('focus', () => {
    unread = 0
    app.setBadgeCount(0)
    win.flashFrame(false)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  // The renderer shows how to leave full screen; macOS shows its own controls.
  if (process.platform !== 'darwin') win.on('enter-full-screen', () => emit({ type: 'fullScreen' }))
  if (process.platform !== 'darwin') {
    win.webContents.on('before-input-event', (event, input) => {
      if (handleShortcut(win, input)) event.preventDefault()
    })
  }

  // Agent output is untrusted. Never open new windows or navigate away from the
  // app; send web links to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * The default menu's shortcuts, kept on Windows and Linux where Gloss has no menu:
 * zoom always, and DevTools and reload in development.
 */
function handleShortcut(win: BrowserWindow, input: Electron.Input): boolean {
  // AltGr arrives as Ctrl+Alt on Windows; leave it to typing.
  if (input.type !== 'keyDown' || input.alt) return false
  const mod = input.control
  const key = input.key.toLowerCase()
  const contents = win.webContents
  if (mod && (key === '=' || key === '+')) contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 5))
  else if (mod && key === '-') contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3))
  else if (mod && key === '0') contents.setZoomLevel(0)
  // Full screen: a borderless window over the whole monitor. macOS has its own (Ctrl+Cmd+F).
  else if (!mod && !input.shift && key === 'f11') win.setFullScreen(!win.isFullScreen())
  else if (!app.isPackaged && (key === 'f12' || (mod && input.shift && key === 'i'))) contents.toggleDevTools()
  else if (!app.isPackaged && mod && key === 'r') contents.reload()
  else return false
  return true
}

function emit(event: GlossEvent): void {
  mainWindow?.webContents.send(IPC.event, event)
  if (event.type === 'turnEnd') notifyTurnEnd(event)
}

/** Finished turns since the window was last focused (the badge count). */
let unread = 0
/** Shown notifications, kept so their click handlers survive garbage collection. */
const notifications = new Set<Notification>()

/** An OS notification when a turn ends or fails while Gloss isn't focused. Clicking it opens the session (and thread). */
function notifyTurnEnd(event: Extract<GlossEvent, { type: 'turnEnd' }>): void {
  const win = mainWindow
  // A queued message starting next isn't the end of the agent's work.
  if (!win || win.isFocused() || event.stopReason === 'cancelled' || event.continues || !Notification.isSupported()) return
  const session = store?.getSession(event.sessionId)
  if (!session) return
  const body = event.error
    ? `The turn failed: ${event.error}`
    : event.threadId
      ? 'The agent replied in a thread.'
      : 'The agent finished.'
  const n = new Notification({ title: session.title, body })
  notifications.add(n)
  n.on('click', () => {
    notifications.delete(n)
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    emit({ type: 'reveal', sessionId: event.sessionId, threadId: event.threadId })
  })
  n.on('close', () => notifications.delete(n))
  n.show()
  unread++
  // A badge where the OS has one (macOS, some Linux docks); Windows flashes the taskbar button.
  app.setBadgeCount(unread)
  if (process.platform === 'win32') win.flashFrame(true)
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Expected ${name} to be a string`)
  return value
}

function anchorArg(value: unknown): Anchor {
  const a = value as Partial<Record<string, unknown>> | null
  if (!a || typeof a.text !== 'string') throw new Error('Invalid anchor')
  if (a.kind === 'listItem' && Array.isArray(a.path) && a.path.every((n) => typeof n === 'number')) {
    return { kind: 'listItem', path: a.path as number[], text: a.text }
  }
  if (a.kind === 'selection' && typeof a.start === 'number' && typeof a.end === 'number') {
    return { kind: 'selection', start: a.start, end: a.end, text: a.text }
  }
  if (
    a.kind === 'line' &&
    typeof a.file === 'string' &&
    (a.side === 'old' || a.side === 'new') &&
    typeof a.start === 'number' &&
    typeof a.end === 'number' &&
    Array.isArray(a.lines) &&
    a.lines.every((l) => typeof l === 'string')
  ) {
    return { kind: 'line', file: a.file, side: a.side, start: a.start, end: a.end, text: a.text, lines: a.lines as string[] }
  }
  throw new Error('Invalid anchor')
}

const MAX_ATTACHMENTS = 20
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_CHARS = 1024 * 1024

function attachmentsArg(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error('Invalid attachments')
  return value.map((v: unknown): Attachment => {
    const a = v as Partial<Record<string, unknown>> | null
    if (!a || typeof a.name !== 'string') throw new Error('Invalid attachment')
    if (
      a.kind === 'image' &&
      typeof a.mimeType === 'string' &&
      a.mimeType.startsWith('image/') &&
      typeof a.data === 'string' &&
      a.data.length <= (MAX_IMAGE_BYTES * 4) / 3 + 4
    ) {
      return { kind: 'image', name: a.name, mimeType: a.mimeType, data: a.data }
    }
    if (a.kind === 'file' && typeof a.text === 'string') {
      if (a.text.length > MAX_FILE_CHARS) throw new Error(`${a.name} is too large to attach.`)
      return {
        kind: 'file',
        name: a.name,
        text: a.text,
        ...(typeof a.path === 'string' && a.path ? { path: a.path } : {}),
        ...(typeof a.mimeType === 'string' && a.mimeType ? { mimeType: a.mimeType } : {})
      }
    }
    throw new Error(`Invalid attachment ${a.name}`)
  })
}

/** A folder path: an empty one would make the agent list every project's sessions. */
function folderArg(value: unknown, name: string): string {
  const path = str(value, name)
  if (path.trim() === '') throw new Error(`Expected ${name} to be a folder path`)
  return path
}

function threadArg(value: unknown): string | null {
  return value === null ? null : str(value, 'threadId')
}

function exportLog(id: string, threadId: string | null): { title: string; markdown: string } {
  const s = store!
  const session = s.getSession(id)
  if (!session) throw new Error(`Unknown session ${id}`)
  const markdown = toMarkdown(
    { session, messages: s.listMessages(id), toolCalls: s.listToolCalls(id), threads: s.listThreads(id) },
    threadId
  )
  return { title: session.title, markdown }
}

async function pickFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

function registerIpc(manager: SessionManager, settingsFile: SettingsFile): void {
  ipcMain.handle(IPC.agentsList, () => listAgents())
  ipcMain.handle(IPC.projectsList, () => manager.listProjects())
  ipcMain.handle(IPC.projectsOpen, async () => {
    const path = await pickFolder()
    return path ? manager.addProject(path) : null
  })
  ipcMain.handle(IPC.projectsAgentSessions, (_e, path: unknown, agentId: unknown) =>
    manager.agentSessions(folderArg(path, 'path'), str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.projectsDelete, (_e, path: unknown) => manager.deleteProject(folderArg(path, 'path')))
  ipcMain.handle(IPC.sessionsList, () => manager.listSessions())
  ipcMain.handle(IPC.search, (_e, request: SearchRequest) => store!.search(request))
  ipcMain.handle(IPC.history, () => manager.messageHistory())
  ipcMain.handle(IPC.sessionsCreate, (_e, cwd: unknown, agentId: unknown) =>
    manager.createSession(folderArg(cwd, 'cwd'), str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.sessionsCreateReview, (_e, cwd: unknown, agentId: unknown, baseRef: unknown, headRef: unknown) =>
    manager.createReview(
      folderArg(cwd, 'cwd'),
      str(agentId, 'agentId'),
      baseRef == null ? undefined : { baseRef: str(baseRef, 'baseRef'), ...(headRef == null ? {} : { headRef: str(headRef, 'headRef') }) }
    )
  )
  ipcMain.handle(IPC.sessionsReviewRefs, (_e, id: unknown) => manager.reviewRefs(str(id, 'id')))
  ipcMain.handle(IPC.sessionsOpenReviewFile, async (_e, id: unknown, path: unknown, how: unknown, line: unknown) => {
    const file = await manager.reviewFilePath(str(id, 'id'), str(path, 'path'))
    if (how === 'reveal') return shell.showItemInFolder(file)
    const args = editorArgs(settingsFile.state().global.externalEditor, file, typeof line === 'number' && line > 0 ? Math.floor(line) : 1)
    if (args.length > 0) return launchEditor(args, file)
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.sessionsSetReviewRange, (_e, id: unknown, baseRef: unknown, headRef: unknown) =>
    manager.setReviewRange(str(id, 'id'), {
      baseRef: str(baseRef, 'baseRef'),
      ...(headRef == null ? {} : { headRef: str(headRef, 'headRef') })
    })
  )
  ipcMain.handle(IPC.sessionsReviewDiff, (_e, id: unknown) => manager.reviewDiff(str(id, 'id')))
  ipcMain.handle(IPC.sessionsReviewFile, (_e, id: unknown, path: unknown) =>
    manager.reviewFile(str(id, 'id'), str(path, 'path'))
  )
  ipcMain.handle(
    IPC.sessionsImport,
    (_e, cwd: unknown, agentId: unknown, acpSessionId: unknown, title: unknown, listedAt: unknown) =>
      manager.importSession(
        folderArg(cwd, 'cwd'),
        str(agentId, 'agentId'),
        str(acpSessionId, 'acpSessionId'),
        str(title, 'title'),
        typeof listedAt === 'string' ? listedAt : undefined
      )
  )
  ipcMain.handle(IPC.sessionsOpen, (_e, id: unknown) => manager.openSession(str(id, 'id')))
  ipcMain.handle(IPC.sessionsRefresh, (_e, id: unknown) => manager.refreshSession(str(id, 'id')))
  ipcMain.handle(IPC.sessionsRename, (_e, id: unknown, title: unknown) =>
    manager.renameSession(str(id, 'id'), str(title, 'title'))
  )
  ipcMain.handle(IPC.sessionsDelete, (_e, id: unknown) => manager.deleteSession(str(id, 'id')))
  ipcMain.handle(IPC.sessionsSetChoice, (_e, id: unknown, kind: unknown, value: unknown) => {
    if (kind !== 'model' && kind !== 'effort') throw new Error('kind must be "model" or "effort"')
    return manager.setChoice(str(id, 'id'), kind, str(value, 'value'))
  })
  ipcMain.handle(IPC.sessionsCopyMarkdown, (_e, id: unknown, threadId: unknown) => {
    clipboard.writeText(exportLog(str(id, 'id'), threadArg(threadId)).markdown)
  })
  ipcMain.handle(IPC.sessionsSaveMarkdown, async (_e, id: unknown, threadId: unknown) => {
    const { title, markdown } = exportLog(str(id, 'id'), threadArg(threadId))
    const options: Electron.SaveDialogOptions = {
      defaultPath: `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'session'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, markdown)
    return true
  })
  // Takes the session, not a path: shell.openPath would run a file it was given.
  ipcMain.handle(IPC.sessionsOpenFolder, async (_e, id: unknown) => {
    const session = store!.getSession(str(id, 'id'))
    if (!session) throw new Error(`Unknown session ${String(id)}`)
    const error = await shell.openPath(session.cwd)
    return error === '' ? null : error
  })
  ipcMain.handle(IPC.sessionsPlanUsage, (_e, id: unknown) => {
    const session = store!.getSession(str(id, 'id'))
    if (!session) throw new Error(`Unknown session ${String(id)}`)
    return usage.get(session.agentId, session.cwd)
  })
  ipcMain.handle(IPC.gitStatus, (_e, cwd: unknown) => gitStatus(str(cwd, 'cwd')))
  ipcMain.handle(IPC.gitPullRequest, (_e, cwd: unknown) => pullRequest(str(cwd, 'cwd')))
  ipcMain.handle(IPC.threadsCreate, (_e, sessionId: unknown, anchorMessageId: unknown, anchor: unknown) =>
    manager.createThread(
      str(sessionId, 'sessionId'),
      anchorMessageId === null ? null : str(anchorMessageId, 'anchorMessageId'),
      anchorArg(anchor)
    )
  )
  ipcMain.handle(IPC.threadsResolve, (_e, sessionId: unknown, threadId: unknown, resolved: unknown) => {
    if (typeof resolved !== 'boolean') throw new Error('Expected resolved to be a boolean')
    return manager.resolveThread(str(sessionId, 'sessionId'), str(threadId, 'threadId'), resolved)
  })
  ipcMain.handle(
    IPC.send,
    (_e, sessionId: unknown, text: unknown, threadId: unknown, attachments: unknown, fromThread: unknown) =>
      manager.send(
        str(sessionId, 'sessionId'),
        str(text, 'text'),
        threadArg(threadId),
        attachmentsArg(attachments),
        threadArg(fromThread)
      )
  )
  ipcMain.handle(IPC.steer, (_e, sessionId: unknown, text: unknown, threadId: unknown, attachments: unknown) =>
    manager.steer(str(sessionId, 'sessionId'), str(text, 'text'), threadArg(threadId), attachmentsArg(attachments))
  )
  ipcMain.handle(IPC.cancel, (_e, sessionId: unknown) => manager.cancel(str(sessionId, 'sessionId')))
  ipcMain.handle(IPC.queueEdit, (_e, sessionId: unknown, id: unknown, text: unknown) =>
    manager.editQueued(str(sessionId, 'sessionId'), str(id, 'id'), str(text, 'text'))
  )
  ipcMain.handle(IPC.queueRemove, (_e, sessionId: unknown, id: unknown) =>
    manager.removeQueued(str(sessionId, 'sessionId'), str(id, 'id'))
  )
  ipcMain.handle(IPC.queueResume, (_e, sessionId: unknown) => manager.resumeQueue(str(sessionId, 'sessionId')))
  ipcMain.handle(IPC.authSignIn, (_e, agentId: unknown, methodId: unknown) =>
    manager.signIn(str(agentId, 'agentId'), str(methodId, 'methodId'))
  )
  ipcMain.handle(IPC.authDismiss, (_e, agentId: unknown) =>
    manager.dismissSignIn(str(agentId, 'agentId'))
  )

  ipcMain.handle(IPC.settingsGet, () => settingsFile.state())
  ipcMain.handle(IPC.settingsPreviewMcpImport, (_e, source: unknown) => {
    if (source !== 'claude' && source !== 'codex' && source !== 'gloss') throw new Error('Unknown MCP import source')
    return previewMcpImport(source, { projects: manager.listProjects().map((p) => p.path), legacy: settingsFile.state().projects })
  })
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: unknown) => settingsFile.update(patchArg(patch)))
  ipcMain.handle(IPC.settingsOpenFile, async () => {
    const error = await shell.openPath(settingsFile.path)
    return error === '' ? null : error
  })
}

// Windows shows notifications only for an app with an AppUserModelID.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'app.gloss' : process.execPath)

app.whenReady().then(() => {
  // No File/Edit/View/Window menu bar on Windows and Linux. macOS keeps its menu
  // (it lives in the system menu bar, and copy and paste need its Edit menu).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  const dataDir = app.getPath('userData')
  store = new Store(join(dataDir, 'gloss.db'))
  const settingsFile = new SettingsFile({
    dir: dataDir,
    defaults: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] },
    onChange(next) {
      emit({ type: 'settings', state: next })
    }
  })
  settings = settingsFile
  settingsFile.load()
  settingsFile.watch()
  sessions = new SessionManager({
    store,
    emit,
    getAgentConfig,
    mcpServers: () => settingsFile.state().global.mcpServers,
    agentEnv: (config) => agentEnv(config),
    connect: (config, env, handlers) => AgentConnection.start(config, env, handlers),
    runInTerminal
  })
  registerIpc(sessions, settingsFile)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  settings?.close()
  void sessions?.dispose()
  store?.close()
})
