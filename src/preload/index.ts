import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type GlossApi, type GlossEvent } from '../shared/ipc'

const api: GlossApi = {
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList)
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    create: (cwd, agentId) => ipcRenderer.invoke(IPC.sessionsCreate, cwd, agentId),
    open: (id) => ipcRenderer.invoke(IPC.sessionsOpen, id)
  },
  threads: {
    create: (sessionId, anchorMessageId, anchor) =>
      ipcRenderer.invoke(IPC.threadsCreate, sessionId, anchorMessageId, anchor)
  },
  send: (sessionId, text, threadId) => ipcRenderer.invoke(IPC.send, sessionId, text, threadId),
  cancel: (sessionId) => ipcRenderer.invoke(IPC.cancel, sessionId),
  auth: {
    signIn: (agentId, methodId) => ipcRenderer.invoke(IPC.authSignIn, agentId, methodId),
    dismiss: (agentId) => ipcRenderer.invoke(IPC.authDismiss, agentId)
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    setDevModel: (on) => ipcRenderer.invoke(IPC.settingsSetDevModel, on === true)
  },
  onEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, event: GlossEvent): void => listener(event)
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.removeListener(IPC.event, wrapped)
  }
}

contextBridge.exposeInMainWorld('gloss', api)
