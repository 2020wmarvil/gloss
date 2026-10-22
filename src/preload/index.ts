import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type GlossApi, type GlossEvent } from '../shared/ipc'

const api: GlossApi = {
  openFileLink: (href) => ipcRenderer.invoke(IPC.openFileLink, href),
  search: (request) => ipcRenderer.invoke(IPC.search, request),
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList),
    testOpenCode: (executable) => ipcRenderer.invoke(IPC.agentsTestOpenCode, executable),
    testProfile: (profile) => ipcRenderer.invoke(IPC.agentsTestProfile, profile)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    open: () => ipcRenderer.invoke(IPC.projectsOpen),
    agentSessions: (path, agentId) => ipcRenderer.invoke(IPC.projectsAgentSessions, path, agentId),
    delete: (path) => ipcRenderer.invoke(IPC.projectsDelete, path)
  },
  history: () => ipcRenderer.invoke(IPC.history),
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessionsList),
    create: (cwd, agentId) => ipcRenderer.invoke(IPC.sessionsCreate, cwd, agentId),
    createReview: (cwd, agentId, baseRef, headRef) => ipcRenderer.invoke(IPC.sessionsCreateReview, cwd, agentId, baseRef, headRef),
    reviewRefs: (id) => ipcRenderer.invoke(IPC.sessionsReviewRefs, id),
    openReviewFile: (id, path, how, line) => ipcRenderer.invoke(IPC.sessionsOpenReviewFile, id, path, how, line),
    setReviewRange: (id, baseRef, headRef) => ipcRenderer.invoke(IPC.sessionsSetReviewRange, id, baseRef, headRef),
    reviewDiff: (id) => ipcRenderer.invoke(IPC.sessionsReviewDiff, id),
    reviewFile: (id, path) => ipcRenderer.invoke(IPC.sessionsReviewFile, id, path),
    import: (cwd, agentId, acpSessionId, title, listedAt) =>
      ipcRenderer.invoke(IPC.sessionsImport, cwd, agentId, acpSessionId, title, listedAt),
    open: (id) => ipcRenderer.invoke(IPC.sessionsOpen, id),
    refresh: (id) => ipcRenderer.invoke(IPC.sessionsRefresh, id),
    rename: (id, title) => ipcRenderer.invoke(IPC.sessionsRename, id, title),
    delete: (id) => ipcRenderer.invoke(IPC.sessionsDelete, id),
    setChoice: (id, kind, value) => ipcRenderer.invoke(IPC.sessionsSetChoice, id, kind, value),
    setMode: (id, modeId) => ipcRenderer.invoke(IPC.sessionsSetMode, id, modeId),
    setAutoApprove: (id, on) => ipcRenderer.invoke(IPC.sessionsSetAutoApprove, id, on),
    copyMarkdown: (id, threadId) => ipcRenderer.invoke(IPC.sessionsCopyMarkdown, id, threadId),
    saveMarkdown: (id, threadId) => ipcRenderer.invoke(IPC.sessionsSaveMarkdown, id, threadId),
    openFolder: (id) => ipcRenderer.invoke(IPC.sessionsOpenFolder, id),
    openObsidian: (id) => ipcRenderer.invoke(IPC.sessionsOpenObsidian, id),
    planUsage: (id) => ipcRenderer.invoke(IPC.sessionsPlanUsage, id)
  },
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd),
    pullRequest: (cwd) => ipcRenderer.invoke(IPC.gitPullRequest, cwd)
  },
  threads: {
    create: (sessionId, anchorMessageId, anchor) =>
      ipcRenderer.invoke(IPC.threadsCreate, sessionId, anchorMessageId, anchor),
    resolve: (sessionId, threadId, resolved) => ipcRenderer.invoke(IPC.threadsResolve, sessionId, threadId, resolved)
  },
  send: (sessionId, text, threadId, attachments, fromThread) =>
    ipcRenderer.invoke(IPC.send, sessionId, text, threadId, attachments, fromThread ?? null),
  steer: (sessionId, text, threadId, attachments) =>
    ipcRenderer.invoke(IPC.steer, sessionId, text, threadId, attachments),
  retry: (sessionId, messageId) => ipcRenderer.invoke(IPC.retry, sessionId, messageId),
  cancel: (sessionId) => ipcRenderer.invoke(IPC.cancel, sessionId),
  setBadge: (badge) => ipcRenderer.send(IPC.setBadge, badge),
  capture: {
    start: () => ipcRenderer.invoke(IPC.captureStart)
  },
  requests: {
    answer: (sessionId, requestId, answer) => ipcRenderer.invoke(IPC.requestsAnswer, sessionId, requestId, answer)
  },
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
    previewMcpImport: (source) => ipcRenderer.invoke(IPC.settingsPreviewMcpImport, source),
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
