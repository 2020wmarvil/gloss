import { IPC, type GlossApi, type GlossEvent } from './ipc'

/** How the API reaches the main process: IPC in a window's preload, the bridge's WebSocket on a phone. */
export type ApiTransport = {
  invoke(channel: string, ...args: unknown[]): Promise<never>
  send(channel: string, ...args: unknown[]): void
  onEvent(listener: (event: GlossEvent) => void): () => void
  pathFor(file: File): string
}

/** The API a window's preload exposes as `window.gloss`, and the phone client builds over the bridge. */
export function makeApi(t: ApiTransport): GlossApi {
  // Called through the transport, which may be a class instance.
  const invoke = (channel: string, ...args: unknown[]): Promise<never> => t.invoke(channel, ...args)
  const send = (channel: string, ...args: unknown[]): void => t.send(channel, ...args)
  return {
    confirmClose: (requestId, close) => invoke(IPC.confirmClose, requestId, close),
    composer: {
      shell: (id, command) => invoke(IPC.composerShell, id, command),
      cancelShell: (id) => invoke(IPC.composerCancelShell, id),
      contexts: (id, query) => invoke(IPC.composerContexts, id, query),
      attach: (id, item) => invoke(IPC.composerAttach, id, item),
      editDraft: (text) => invoke(IPC.composerEditDraft, text)
    },
    readMarkdownImage: (src, cwd) => invoke(IPC.readMarkdownImage, src, cwd),
    openFileLink: (href) => invoke(IPC.openFileLink, href),
    search: (request) => invoke(IPC.search, request),
    agents: {
      list: () => invoke(IPC.agentsList),
      rateLimits: () => invoke(IPC.agentsRateLimits),
      testOpenCode: (executable) => invoke(IPC.agentsTestOpenCode, executable),
      testProfile: (profile) => invoke(IPC.agentsTestProfile, profile)
    },
    projects: {
      list: () => invoke(IPC.projectsList),
      open: () => invoke(IPC.projectsOpen),
      agentSessions: (path, agentId) => invoke(IPC.projectsAgentSessions, path, agentId),
      delete: (path) => invoke(IPC.projectsDelete, path)
    },
    history: () => invoke(IPC.history),
    sessions: {
      rewindPoints: (id) => invoke(IPC.sessionsRewindPoints, id),
      rewind: (id, messageId) => invoke(IPC.sessionsRewind, id, messageId),
      list: () => invoke(IPC.sessionsList),
      create: (cwd, agentId) => invoke(IPC.sessionsCreate, cwd, agentId),
      createInWorktree: (project, agentId) => invoke(IPC.sessionsCreateInWorktree, project, agentId),
      createIn: (project, path, agentId) => invoke(IPC.sessionsCreateIn, project, path, agentId),
      createReview: (cwd, agentId, baseRef, headRef) => invoke(IPC.sessionsCreateReview, cwd, agentId, baseRef, headRef),
      runReview: (id) => invoke(IPC.sessionsRunReview, id),
      reviewRefs: (id) => invoke(IPC.sessionsReviewRefs, id),
      openReviewFile: (id, path, how, line) => invoke(IPC.sessionsOpenReviewFile, id, path, how, line),
      setReviewRange: (id, baseRef, headRef) => invoke(IPC.sessionsSetReviewRange, id, baseRef, headRef),
      reviewDiff: (id) => invoke(IPC.sessionsReviewDiff, id),
      reviewFile: (id, path) => invoke(IPC.sessionsReviewFile, id, path),
      import: (cwd, agentId, acpSessionId, title, listedAt, project) =>
        invoke(IPC.sessionsImport, cwd, agentId, acpSessionId, title, listedAt, project),
      open: (id) => invoke(IPC.sessionsOpen, id),
      refresh: (id) => invoke(IPC.sessionsRefresh, id),
      rename: (id, title) => invoke(IPC.sessionsRename, id, title),
      delete: (id) => invoke(IPC.sessionsDelete, id),
      setChoice: (id, kind, value) => invoke(IPC.sessionsSetChoice, id, kind, value),
      setMode: (id, modeId) => invoke(IPC.sessionsSetMode, id, modeId),
      setAutoApprove: (id, on) => invoke(IPC.sessionsSetAutoApprove, id, on),
      copyMarkdown: (id, threadId) => invoke(IPC.sessionsCopyMarkdown, id, threadId),
      saveMarkdown: (id, threadId) => invoke(IPC.sessionsSaveMarkdown, id, threadId),
      openFolder: (id) => invoke(IPC.sessionsOpenFolder, id),
      openObsidian: (id) => invoke(IPC.sessionsOpenObsidian, id),
      planUsage: (id) => invoke(IPC.sessionsPlanUsage, id)
    },
    worktrees: {
      list: (project) => invoke(IPC.worktreesList, project),
      remove: (project, path) => invoke(IPC.worktreesRemove, project, path)
    },
    git: {
      status: (cwd) => invoke(IPC.gitStatus, cwd),
      pullRequest: (cwd) => invoke(IPC.gitPullRequest, cwd)
    },
    threads: {
      create: (sessionId, anchorMessageId, anchor) =>
        invoke(IPC.threadsCreate, sessionId, anchorMessageId, anchor),
      resolve: (sessionId, threadId, resolved) => invoke(IPC.threadsResolve, sessionId, threadId, resolved)
    },
    send: (sessionId, text, threadId, attachments, fromThread) =>
      invoke(IPC.send, sessionId, text, threadId, attachments, fromThread ?? null),
    steer: (sessionId, text, threadId, attachments) =>
      invoke(IPC.steer, sessionId, text, threadId, attachments),
    retry: (sessionId, messageId) => invoke(IPC.retry, sessionId, messageId),
    cancel: (sessionId) => invoke(IPC.cancel, sessionId),
    setBadge: (badge) => send(IPC.setBadge, badge),
    capture: {
      start: () => invoke(IPC.captureStart),
      shortcutStatus: () => invoke(IPC.captureShortcutStatus),
      pauseShortcut: (paused) => invoke(IPC.capturePauseShortcut, paused)
    },
    annotate: {
      open: (request) => invoke(IPC.annotateOpen, request),
      initial: () => invoke(IPC.annotateInitial),
      finish: (result) => invoke(IPC.annotateFinish, result),
      minimize: () => send(IPC.annotateMinimize),
      toggleMaximize: () => send(IPC.annotateToggleMaximize)
    },
    requests: {
      answer: (sessionId, requestId, answer) => invoke(IPC.requestsAnswer, sessionId, requestId, answer)
    },
    queue: {
      edit: (sessionId, id, text) => invoke(IPC.queueEdit, sessionId, id, text),
      remove: (sessionId, id) => invoke(IPC.queueRemove, sessionId, id),
      resume: (sessionId) => invoke(IPC.queueResume, sessionId)
    },
    auth: {
      signIn: (agentId, methodId) => invoke(IPC.authSignIn, agentId, methodId),
      dismiss: (agentId) => invoke(IPC.authDismiss, agentId)
    },
    files: {
      pathFor: (file) => t.pathFor(file)
    },
    settings: {
      previewMcpImport: (source) => invoke(IPC.settingsPreviewMcpImport, source),
      get: () => invoke(IPC.settingsGet),
      update: (patch) => invoke(IPC.settingsUpdate, patch),
      openFile: () => invoke(IPC.settingsOpenFile)
    },
    windows: {
      popOut: (sessionId, state) => invoke(IPC.windowsPopOut, sessionId, state),
      popIn: (state) => invoke(IPC.windowsPopIn, state),
      focus: (sessionId) => invoke(IPC.windowsFocus, sessionId),
      list: () => invoke(IPC.windowsList),
      initial: () => invoke(IPC.windowsInitial),
      toMain: (action) => send(IPC.windowsToMain, action)
    },
    phone: {
      status: () => invoke(IPC.phoneStatus),
      retry: () => invoke(IPC.phoneRetry),
      pair: () => invoke(IPC.phonePair),
      cancelPairing: () => invoke(IPC.phoneCancelPairing),
      removeDevice: (id) => invoke(IPC.phoneRemoveDevice, id)
    },
    onEvent: (listener) => t.onEvent(listener)
  }
}
