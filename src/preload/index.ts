import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type GlossApi, type GlossEvent } from '../shared/ipc'

const api: GlossApi = {
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    open: () => ipcRenderer.invoke(IPC.projectsOpen),
    agentSessions: (path, agentId) => ipcRenderer.invoke(IPC.projectsAgentSessions, path, agentId)
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    create: (cwd, agentId) => ipcRenderer.invoke(IPC.sessionsCreate, cwd, agentId),
    import: (cwd, agentId, acpSessionId, title) =>
      ipcRenderer.invoke(IPC.sessionsImport, cwd, agentId, acpSessionId, title),
    open: (id) => ipcRenderer.invoke(IPC.sessionsOpen, id),
    rename: (id, title) => ipcRenderer.invoke(IPC.sessionsRename, id, title),
    delete: (id) => ipcRenderer.invoke(IPC.sessionsDelete, id),
    setModel: (id, value) => ipcRenderer.invoke(IPC.sessionsSetModel, id, value),
    copyMarkdown: (id, threadId) => ipcRenderer.invoke(IPC.sessionsCopyMarkdown, id, threadId),
    saveMarkdown: (id, threadId) => ipcRenderer.invoke(IPC.sessionsSaveMarkdown, id, threadId)
  },
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd)
  },
  threads: {
    create: (sessionId, anchorMessageId, anchor) =>
      ipcRenderer.invoke(IPC.threadsCreate, sessionId, anchorMessageId, anchor)
  },
  send: (sessionId, text, threadId, attachments) =>
    ipcRenderer.invoke(IPC.send, sessionId, text, threadId, attachments),
  cancel: (sessionId) => ipcRenderer.invoke(IPC.cancel, sessionId),
  auth: {
    signIn: (agentId, methodId) => ipcRenderer.invoke(IPC.authSignIn, agentId, methodId),
    dismiss: (agentId) => ipcRenderer.invoke(IPC.authDismiss, agentId)
  },
  files: {
    pathFor: (file) => webUtils.getPathForFile(file)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    openFile: () => ipcRenderer.invoke(IPC.settingsOpenFile)
  },
  onEvent(listener) {
    const wrapped = (_e: IpcRendererEvent, event: GlossEvent): void => listener(event)
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.removeListener(IPC.event, wrapped)
  }
}

contextBridge.exposeInMainWorld('gloss', api)
