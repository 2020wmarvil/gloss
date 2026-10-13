import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, type GlossEvent } from '../shared/ipc'
import type { Anchor } from '../shared/types'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig, listAgents } from './agents'
import { Store } from './db'
import { SessionManager } from './sessions'
import { patchArg, SettingsFile } from './settings'
import { runInTerminal } from './terminal'

let mainWindow: BrowserWindow | undefined
let store: Store | undefined
let sessions: SessionManager | undefined
let settings: SettingsFile | undefined

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
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })

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

function emit(event: GlossEvent): void {
  mainWindow?.webContents.send(IPC.event, event)
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
  throw new Error('Invalid anchor')
}

function registerIpc(manager: SessionManager, settingsFile: SettingsFile): void {
  ipcMain.handle(IPC.agentsList, () => listAgents())
  ipcMain.handle(IPC.sessionsList, () => manager.listSessions())
  ipcMain.handle(IPC.sessionsCreate, (_e, cwd: unknown, agentId: unknown) =>
    manager.createSession(str(cwd, 'cwd'), str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.sessionsOpen, (_e, id: unknown) => manager.openSession(str(id, 'id')))
  ipcMain.handle(IPC.threadsCreate, (_e, sessionId: unknown, anchorMessageId: unknown, anchor: unknown) =>
    manager.createThread(str(sessionId, 'sessionId'), str(anchorMessageId, 'anchorMessageId'), anchorArg(anchor))
  )
  ipcMain.handle(IPC.send, (_e, sessionId: unknown, text: unknown, threadId: unknown) =>
    manager.send(
      str(sessionId, 'sessionId'),
      str(text, 'text'),
      threadId === null ? null : str(threadId, 'threadId')
    )
  )
  ipcMain.handle(IPC.cancel, (_e, sessionId: unknown) => manager.cancel(str(sessionId, 'sessionId')))
  ipcMain.handle(IPC.authSignIn, (_e, agentId: unknown, methodId: unknown) =>
    manager.signIn(str(agentId, 'agentId'), str(methodId, 'methodId'))
  )
  ipcMain.handle(IPC.authDismiss, (_e, agentId: unknown) =>
    manager.dismissSignIn(str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.pickDirectory, async () => {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.settingsGet, () => settingsFile.state())
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: unknown) => settingsFile.update(patchArg(patch)))
  ipcMain.handle(IPC.settingsOpenFile, async () => {
    const error = await shell.openPath(settingsFile.path)
    return error === '' ? null : error
  })
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  store = new Store(join(dataDir, 'gloss.db'))
  const settingsFile = new SettingsFile({
    dir: dataDir,
    // The cheap dev model is on by default in development, off in packaged builds.
    defaults: { devModel: !app.isPackaged },
    onChange(next, prev) {
      emit({ type: 'settings', state: next })
      // Agents restart with the new model; busy ones once their turn ends.
      if (next.global.devModel !== prev.global.devModel) void sessions?.restartAgents()
    }
  })
  settings = settingsFile
  settingsFile.load()
  settingsFile.watch()
  sessions = new SessionManager({
    store,
    emit,
    getAgentConfig,
    agentEnv: (config) => agentEnv(config, { devModel: settingsFile.state().global.devModel }),
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
