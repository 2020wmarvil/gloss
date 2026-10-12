import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC, type GlossEvent } from '../shared/ipc'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig, listAgents } from './agents'
import { Store } from './db'
import { SessionManager } from './sessions'
import { getSettings, updateSettings } from './settings'
import { runInTerminal } from './terminal'

let mainWindow: BrowserWindow | undefined
let store: Store | undefined
let sessions: SessionManager | undefined

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

function registerIpc(manager: SessionManager): void {
  ipcMain.handle(IPC.agentsList, () => listAgents())
  ipcMain.handle(IPC.sessionsList, () => manager.listSessions())
  ipcMain.handle(IPC.sessionsCreate, (_e, cwd: unknown, agentId: unknown) =>
    manager.createSession(str(cwd, 'cwd'), str(agentId, 'agentId'))
  )
  ipcMain.handle(IPC.sessionsOpen, (_e, id: unknown) => manager.openSession(str(id, 'id')))
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
  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSetDevModel, async (_e, on: unknown) => {
    const settings = updateSettings({ devModel: on === true })
    // Agents restart with the new model; busy ones once their turn ends.
    await manager.restartAgents()
    return settings
  })
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'gloss.db'))
  sessions = new SessionManager({
    store,
    emit,
    getAgentConfig,
    agentEnv: (config) => agentEnv(config, { devModel: getSettings().devModel }),
    connect: (config, env, handlers) => AgentConnection.start(config, env, handlers),
    runInTerminal
  })
  registerIpc(sessions)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void sessions?.dispose()
  store?.close()
})
