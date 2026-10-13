import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type GlossApi, type GlossEvent } from '../shared/ipc'

const api: GlossApi = {
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    open: () => ipcRenderer.invoke(IPC.projectsOpen),
    agentSessions: (path, agentId) => ipcRenderer.invoke(IPC.projectsAgentSessions, path, agentId),
    delete: (path) => ipcRenderer.invoke(IPC.projectsDelete, path)
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    create: (cwd, agentId) => ipcRenderer.invoke(IPC.sessionsCreate, cwd, agentId),
    import: (cwd, agentId, acpSessionId, title, listedAt) =>
      ipcRenderer.invoke(IPC.sessionsImport, cwd, agentId, acpSessionId, title, listedAt),
    open: (id) => ipcRenderer.invoke(IPC.sessionsOpen, id),
    refresh: (id) => ipcRenderer.invoke(IPC.sessionsRefresh, id),
    rename: (id, title) => ipcRenderer.invoke(IPC.sessionsRename, id, title),
    delete: (id) => ipcRenderer.invoke(IPC.sessionsDelete, id),
    setModel: (id, value) => ipcRenderer.invoke(IPC.sessionsSetModel, id, value),
    copyMarkdown: (id, threadId) => ipcRenderer.invoke(IPC.sessionsCopyMarkdown, id, threadId),
    saveMarkdown: (id, threadId) => ipcRenderer.invoke(IPC.sessionsSaveMarkdown, id, threadId),
    openFolder: (id) => ipcRenderer.invoke(IPC.sessionsOpenFolder, id),
    planUsage: (id) => ipcRenderer.invoke(IPC.sessionsPlanUsage, id)
  },
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd),
    pullRequest: (cwd) => ipcRenderer.invoke(IPC.gitPullRequest, cwd)
  },
  threads: {
    create: (sessionId, anchorMessageId, anchor) =>
      ipcRenderer.invoke(IPC.threadsCreate, sessionId, anchorMessageId, anchor)
  },
  send: (sessionId, text, threadId, attachments) =>
    ipcRenderer.invoke(IPC.send, sessionId, text, threadId, attachments),
  steer: (sessionId, text, threadId, attachments) =>
    ipcRenderer.invoke(IPC.steer, sessionId, text, threadId, attachments),
  cancel: (sessionId) => ipcRenderer.invoke(IPC.cancel, sessionId),
  queue: {
    edit: (sessionId, id, text) => ipcRenderer.invoke(IPC.queueEdit, sessionId, id, text),
    remove: (sessionId, id) => ipcRenderer.invoke(IPC.queueRemove, sessionId, id),
    resume: (sessionId) => ipcRenderer.invoke(IPC.queueResume, sessionId)
  },
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
