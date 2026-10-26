import type { ContextItem, RewindDraft, RewindPoint, ShellResult } from './composer'
import type { SearchRequest, SearchResponse } from './search'
import type { McpImportPreview, McpImportSource } from './mcp'
import type { ReviewDiff, ReviewRefs } from './review'
import type { RequestAnswer, UserRequest } from './requests'
// The IPC contract between the main process and the renderer.
// Type-only (plus channel names): nothing here may pull runtime code into the sandboxed preload.
import type { GlobalSettings, ProjectSettings } from './settings'
import type {
  AgentInfo,
  AgentSession,
  Anchor,
  Attachment,
  AuthMethodInfo,
  Message,
  MessageQueue,
  Plan,
  PlanUsage,
  Project,
  Session,
  SessionLive,
  Thread,
  ToolCall
} from './types'

export type SettingsState = {
  /** Absolute path of settings.json. */
  path: string
  global: GlobalSettings
  /** Keyed by folder path, as written in the file. */
  projects: Record<string, ProjectSettings>
  /** What is wrong with the file, if its last edit was rejected. The settings above are the last good ones. */
  error: string | null
}

export type SettingsPatch = {
  global?: Partial<GlobalSettings>
  project?: { path: string; values: Partial<ProjectSettings> }
}

export type SessionView = {
  session: Session
  messages: Message[]
  toolCalls: ToolCall[]
  plans: Plan[]
  threads: Thread[]
  /** The running turn, if any. */
  turn: { threadId: string | null } | null
  queue: MessageQueue
  live: SessionLive
  /** Questions and approvals the agent is waiting on (SPEC → Questions and approvals). */
  requests: UserRequest[]
}

export type GitStatus = {
  branch: string
  dirty: boolean
  /** The branch's upstream on GitHub; null if it has none or the remote isn't on github.com. */
  url: string | null
}

/** The GitHub pull request for a folder's branch, from `gh pr view`. */
export type PullRequest = {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  /** Combined result of its checks; null if it has none. */
  checks: 'passing' | 'failing' | 'pending' | null
  review: 'approved' | 'changes requested' | 'review required' | null
  /** The branch it merges into, e.g. "main". */
  baseRef: string
}

/**
 * `queued`: a turn was running, so the message was queued instead of sent.
 * `steered`: the message was injected into the running turn.
 * `cleared`: it was `/clear`, which Gloss ran itself.
 */
export type TurnResult = { stopReason?: string; error?: string; queued?: true; steered?: true; cleared?: true }

export type AuthResult = { ok: true } | { ok: false; error: string }

export type OpenCodeStatus = {
  available: boolean
  executable: string | null
  version: string | null
  error: string | null
}

export type AgentProfileStatus = {
  available: boolean
  version: string | null
  error: string | null
  capabilities: { resume: boolean; discovery: boolean; steering: boolean; images: boolean; context: boolean } | null
}

export type GlossEvent =
  | { type: 'agents'; agents: AgentInfo[] }
  | { type: 'confirmClose'; requestId: string; working: number }
  | { type: 'session'; session: Session }
  /** `deletedOutside`: the agent no longer had it, so Gloss deleted it too (SPEC → Shared sessions). */
  | { type: 'sessionDeleted'; sessionId: string; deletedOutside?: { title: string } }
  /** `/clear` emptied the session: its messages, tool calls and threads are gone. */
  | { type: 'sessionCleared'; sessionId: string }
  | { type: 'sessionRewound'; sessionId: string }
  /** The log was synced from the agent's copy: reload it (SPEC → Shared sessions). */
  | { type: 'sessionSynced'; sessionId: string }
  | { type: 'live'; sessionId: string; live: SessionLive }
  /** The user clicked a notification: show this session (and thread). */
  | { type: 'reveal'; sessionId: string; threadId: string | null }
  | { type: 'message'; message: Message }
  /** A steered message that didn't get into the turn (SPEC → Steer). */
  | { type: 'messageDeleted'; sessionId: string; messageId: string }
  | { type: 'toolCall'; toolCall: ToolCall }
  /** A plan was reported, or its entries changed (SPEC → Plans). */
  | { type: 'plan'; plan: Plan }
  | { type: 'thread'; thread: Thread }
  | { type: 'turnStart'; sessionId: string; threadId: string | null }
  | {
      type: 'turnEnd'
      sessionId: string
      threadId: string | null
      stopReason?: string
      error?: string
      /** Recovery offered on the failed-turn notice. */
      recovery?: { messageId: string; action: 'signIn' | 'retry' }
      /** A queued message starts right away. */
      continues?: true
    }
  | { type: 'queue'; sessionId: string; queue: MessageQueue }
  /** The questions and approvals the session's agent is waiting on changed. */
  | { type: 'requests'; sessionId: string; requests: UserRequest[] }
  /** Something the user should know that is not part of the conversation, shown in `threadId`. */
  | { type: 'notice'; sessionId: string; threadId: string | null; text: string }
  /** The window went full screen (F11): show how to leave it. */
  | { type: 'fullScreen' }
  | { type: 'authRequired'; agentId: string; agentName: string; methods: AuthMethodInfo[] }
  | { type: 'authResolved'; agentId: string }
  | { type: 'settings'; state: SettingsState }
  /** The global capture shortcut was pressed (SPEC → Visual feedback). */
  | { type: 'captureShortcut' }
  /** The sessions popped out into their own windows, and the one whose window is focused (SPEC → Session windows). */
  | { type: 'windows'; popped: string[]; focused: string | null }
  /** Main window only: a session window was returned to it, with what it showed. */
  | { type: 'popIn'; sessionId: string; state: PaneState }
  /** Main window only: a shortcut pressed in a session window that acts in the main window. */
  | { type: 'mainAction'; action: MainAction }

/** What a session's view shows, carried when it moves between windows (SPEC → Session windows). */
export type PaneState = {
  /** The side panel's thread; null for the overview (or a review's general conversation). */
  threadId: string | null
  sideOpen: boolean
  /** A review's side panel shows its general conversation. */
  general: boolean
  sideTab: 'threads' | 'queue'
  /** A review's expanded files. */
  expandedFiles: string[]
  /** The session's unsent composer drafts, by draft key. */
  drafts: Record<string, { text: string; attachments: Attachment[] }>
  /** Where its logs and diff are scrolled, by scroller: the bottom, or an element and how far past its top. */
  scroll: Record<string, { bottom: true } | { id: string; block?: string; offset: number }>
}

/** Shortcuts a session window hands to the main window. */
export type MainAction =
  | { kind: 'search' }
  | { kind: 'newSession' }
  | { kind: 'settings' }
  | { kind: 'cycleSession'; back: boolean }
  /** **New review** in a popped-out review: the fresh draft opens in the main window. */
  | { kind: 'newReview'; sessionId: string }

export type GlossApi = {
  confirmClose(requestId: string, close: boolean): Promise<void>
  composer: {
    shell(sessionId: string, command: string): Promise<ShellResult>
    cancelShell(sessionId: string): Promise<void>
    contexts(sessionId: string, query: string): Promise<ContextItem[]>
    attach(sessionId: string, item: ContextItem): Promise<Attachment>
    editDraft(text: string): Promise<{ text: string }>
  }
  /** Opens an absolute local Markdown file link in the editor, or reveals it without an editor. */
  openFileLink(href: string): Promise<void>
  readMarkdownImage(src: string, cwd?: string): Promise<string>
  search(request: SearchRequest): Promise<SearchResponse>
  agents: {
    list(): Promise<AgentInfo[]>
    testOpenCode(executable: string): Promise<OpenCodeStatus>
    testProfile(profile: import('./agentProfiles').AgentProfile): Promise<AgentProfileStatus>
  }
  projects: {
    list(): Promise<Project[]>
    /** Native folder picker; adds the folder as a project. Resolves to null if cancelled. */
    open(): Promise<Project | null>
    /** The agent's own sessions in the folder that Gloss has no record of. Empty if the agent can't list them. */
    agentSessions(path: string, agentId: string): Promise<AgentSession[]>
    /** Deletes the project and its sessions (the agent's copies too). Resolves to a warning if some agent copies couldn't be deleted. */
    delete(path: string): Promise<string | null>
  }
  sessions: {
    list(): Promise<Session[]>
    /** Starts an agent session in `cwd`. Rejects if the agent can't start one. */
    create(cwd: string, agentId: string): Promise<Session>
    /**
     * Opens a draft review of the project's branch, or the project's draft again (SPEC →
     * Review sessions). `baseRef` and `headRef` (null: the working tree) start a new one of that range.
     */
    createReview(cwd: string, agentId: string, baseRef?: string, headRef?: string | null): Promise<Session>
    /** **Run review**: asks the agent for a summary and its findings; the turn runs on. */
    runReview(id: string): Promise<void>
    /** What a review's dropdowns offer. */
    reviewRefs(id: string): Promise<ReviewRefs>
    /** Opens a file of a review's diff (path from the repository root) in the file manager, or in the external editor at `line`. */
    openReviewFile(id: string, path: string, how: 'reveal' | 'editor', line: number): Promise<void>
    /** Changes what a review compares (`headRef` null: the working tree); resolves with the new diff. */
    setReviewRange(id: string, baseRef: string, headRef: string | null): Promise<ReviewDiff>
    /** A review session's diff, read now. */
    reviewDiff(id: string): Promise<ReviewDiff>
    /** A file of a review's diff as it is now (path from the repository root); null if it can't be shown. */
    reviewFile(id: string, path: string): Promise<string[] | null>
    /**
     * Opens one of the agent's sessions in Gloss: its history becomes the log, placed in threads by its tags.
     * `listedAt` (the agent's `updatedAt` in its listing) stands in for when it was made, so it keeps its place.
     */
    import(cwd: string, agentId: string, acpSessionId: string, title: string, listedAt?: string): Promise<Session>
    /** Its log and threads. Also resumes the session on the agent in the background, for the status line. */
    open(id: string): Promise<SessionView>
    rewindPoints(id: string): Promise<RewindPoint[]>
    rewind(id: string, messageId: string): Promise<RewindDraft>
    /** Reloads the session if the agent's copy changed elsewhere (SPEC → Shared sessions). */
    refresh(id: string): Promise<void>
    rename(id: string, title: string): Promise<Session>
    /** Deletes it from Gloss and the agent. Resolves to a warning if the agent's copy couldn't be deleted. */
    delete(id: string): Promise<string | null>
    /** Picks the session's model or effort. */
    setChoice(id: string, kind: 'model' | 'effort', value: string): Promise<void>
    /** Switches the session's permission mode (an ACP mode id). */
    setMode(id: string, modeId: string): Promise<void>
    /** Turns Gloss's own approval of permission requests on or off (agents without a bypass mode). */
    setAutoApprove(id: string, on: boolean): Promise<void>
    /** Copies the session (or one thread) as markdown to the clipboard. */
    copyMarkdown(id: string, threadId: string | null): Promise<void>
    /** Saves the session (or one thread) as a markdown file. Resolves to false if cancelled. */
    saveMarkdown(id: string, threadId: string | null): Promise<boolean>
    /** Opens the session's folder in the system file manager. Resolves to an error message, or null. */
    openFolder(id: string): Promise<string | null>
    /** Opens the session project's configured Obsidian vault. */
    openObsidian(id: string): Promise<void>
    /** Plan usage from the session's agent, for the usage popup. Null if the agent can't be asked. */
    planUsage(id: string): Promise<PlanUsage | null>
  }
  git: {
    /** The folder's branch and whether it has uncommitted changes; null outside a repo. */
    status(cwd: string): Promise<GitStatus | null>
    /** The branch's pull request; null without one, or without `gh` or its login. */
    pullRequest(cwd: string): Promise<PullRequest | null>
  }
  /** The text of the user's messages in every session, newest first, each once (SPEC → Composer → History). */
  history(): Promise<string[]>
  threads: {
    /** Creates the thread for an anchor, or returns the existing one for the same anchor. Line anchors have no message. */
    create(sessionId: string, anchorMessageId: string | null, anchor: Anchor): Promise<Thread>
    /** Resolves a review thread, or reopens it. */
    resolve(sessionId: string, threadId: string, resolved: boolean): Promise<Thread>
  }
  /**
   * Resolves when the turn ends, or right away with `queued` if a turn is running (SPEC → Queue).
   * `fromThread`: a main-thread message sent from that thread (SPEC → Send to main).
   */
  send(
    sessionId: string,
    text: string,
    threadId: string | null,
    attachments: Attachment[],
    fromThread?: string | null
  ): Promise<TurnResult>
  /**
   * Injects a message into the running turn, which must be in `threadId` (SPEC → Steer).
   * Sent as usual when idle; queued first if the turn is just ending.
   */
  steer(sessionId: string, text: string, threadId: string | null, attachments: Attachment[]): Promise<TurnResult>
  retry(sessionId: string, messageId: string): Promise<TurnResult>
  cancel(sessionId: string): Promise<void>
  /** What the taskbar (or dock) badge shows (SPEC → Notifications). */
  setBadge(badge: AppBadge): void
  requests: {
    /** Answers a question or approval. Rejects if it is no longer open. */
    answer(sessionId: string, requestId: string, answer: RequestAnswer): Promise<void>
  }
  queue: {
    /** Replaces a queued message's text. Rejects if it has already been sent. */
    edit(sessionId: string, id: string, text: string): Promise<void>
    remove(sessionId: string, id: string): Promise<void>
    /** Sends the next queued message after the queue paused. */
    resume(sessionId: string): Promise<void>
  }
  auth: {
    signIn(agentId: string, methodId: string): Promise<AuthResult>
    dismiss(agentId: string): Promise<void>
  }
  files: {
    /** The path of a dropped or picked File, if it has one. */
    pathFor(file: File): string
  }
  settings: {
    previewMcpImport(source: McpImportSource): Promise<McpImportPreview>
    get(): Promise<SettingsState>
    /** Writes the changed keys to settings.json, keeping everything else. Rejects if the file isn't valid JSON. */
    update(patch: SettingsPatch): Promise<SettingsState>
    /** Opens settings.json in the system's editor for JSON. Resolves to an error message, or null. */
    openFile(): Promise<string | null>
  }
  capture: {
    /**
     * Freezes the display under the cursor and opens the region overlay (SPEC → Visual feedback).
     * Resolves to what the user picked, or null if they cancelled.
     */
    start(): Promise<import('./capture').Capture | null>
    /** The capture shortcut registered now (normalized), or null, and why not. */
    shortcutStatus(): Promise<{ shortcut: string | null; error: string | null }>
    /** Lets the settings screen record a new shortcut without the current one taking the keys. */
    pauseShortcut(paused: boolean): Promise<void>
  }
  /** Session windows (SPEC → Session windows). */
  windows: {
    /** Main window: pops the session out into its own window, or brings its window forward. */
    popOut(sessionId: string, state: PaneState): Promise<void>
    /** Session window: closes it and opens its session in the main window. */
    popIn(state: PaneState): Promise<void>
    /** Brings a popped-out session's window forward; false if it has none. */
    focus(sessionId: string): Promise<boolean>
    list(): Promise<{ popped: string[]; focused: string | null }>
    /** Session window: its session and the state it opened with. */
    initial(): Promise<{ sessionId: string; state: PaneState } | null>
    /** Session window: brings the main window forward to act there. */
    toMain(action: MainAction): void
  }
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: GlossEvent) => void): () => void
}

/**
 * The app icon's badge: a finished or failed turn the user hasn't looked at, else working
 * while a turn runs; `unseen` counts the sessions behind the first two (a dock count).
 */
export type AppBadge = { state: 'working' | 'completed' | 'failed' | null; unseen: number }

export const IPC = {
  composerContexts: 'gloss:composerContexts',
  composerShell: 'gloss:composerShell',
  composerCancelShell: 'gloss:composerCancelShell',
  composerAttach: 'gloss:composerAttach',
  composerEditDraft: 'gloss:composerEditDraft:v2',
  openFileLink: 'gloss:openFileLink',
  readMarkdownImage: 'gloss:readMarkdownImage',
  settingsPreviewMcpImport: 'gloss:settings:previewMcpImport',
  search: 'gloss:search',
  agentsList: 'gloss:agents:list',
  agentsTestOpenCode: 'gloss:agents:testOpenCode',
  agentsTestProfile: 'gloss:agents:testProfile',
  projectsList: 'gloss:projects:list',
  projectsOpen: 'gloss:projects:open',
  projectsAgentSessions: 'gloss:projects:agentSessions',
  projectsDelete: 'gloss:projects:delete',
  sessionsList: 'gloss:sessions:list',
  sessionsCreate: 'gloss:sessions:create',
  sessionsCreateReview: 'gloss:sessions:createReview',
  sessionsRunReview: 'gloss:sessions:runReview',
  sessionsReviewDiff: 'gloss:sessions:reviewDiff',
  sessionsReviewFile: 'gloss:sessions:reviewFile',
  sessionsReviewRefs: 'gloss:sessions:reviewRefs',
  sessionsOpenReviewFile: 'gloss:sessions:openReviewFile',
  sessionsSetReviewRange: 'gloss:sessions:setReviewRange',
  sessionsImport: 'gloss:sessions:import',
  sessionsOpen: 'gloss:sessions:open',
  sessionsRewindPoints: 'gloss:sessions:rewindPoints',
  sessionsRewind: 'gloss:sessions:rewind',
  sessionsRefresh: 'gloss:sessions:refresh',
  sessionsRename: 'gloss:sessions:rename',
  sessionsDelete: 'gloss:sessions:delete',
  sessionsSetChoice: 'gloss:sessions:setChoice',
  sessionsSetMode: 'gloss:sessions:setMode',
  sessionsSetAutoApprove: 'gloss:sessions:setAutoApprove',
  requestsAnswer: 'gloss:requests:answer',
  sessionsCopyMarkdown: 'gloss:sessions:copyMarkdown',
  sessionsSaveMarkdown: 'gloss:sessions:saveMarkdown',
  sessionsOpenFolder: 'gloss:sessions:openFolder',
  sessionsOpenObsidian: 'gloss:sessions:openObsidian',
  sessionsPlanUsage: 'gloss:sessions:planUsage',
  gitStatus: 'gloss:git:status',
  gitPullRequest: 'gloss:git:pullRequest',
  threadsCreate: 'gloss:threads:create',
  threadsResolve: 'gloss:threads:resolve',
  history: 'gloss:history',
  send: 'gloss:send',
  steer: 'gloss:steer',
  retry: 'gloss:retry',
  cancel: 'gloss:cancel',
  setBadge: 'gloss:setBadge',
  queueEdit: 'gloss:queue:edit',
  queueRemove: 'gloss:queue:remove',
  queueResume: 'gloss:queue:resume',
  authSignIn: 'gloss:auth:signIn',
  authDismiss: 'gloss:auth:dismiss',
  settingsGet: 'gloss:settings:get',
  settingsUpdate: 'gloss:settings:update',
  settingsOpenFile: 'gloss:settings:openFile',
  captureStart: 'gloss:capture:start',
  captureShortcutStatus: 'gloss:capture:shortcutStatus',
  capturePauseShortcut: 'gloss:capture:pauseShortcut',
  windowsPopOut: 'gloss:windows:popOut',
  windowsPopIn: 'gloss:windows:popIn',
  windowsFocus: 'gloss:windows:focus',
  windowsList: 'gloss:windows:list',
  windowsInitial: 'gloss:windows:initial',
  windowsToMain: 'gloss:windows:toMain',
  confirmClose: 'gloss:confirmClose',
  event: 'gloss:event'
} as const
