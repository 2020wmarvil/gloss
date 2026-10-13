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
}

/**
 * `queued`: a turn was running, so the message was queued instead of sent.
 * `steered`: the message was injected into the running turn.
 * `cleared`: it was `/clear`, which Gloss ran itself.
 */
export type TurnResult = { stopReason?: string; error?: string; queued?: true; steered?: true; cleared?: true }

export type AuthResult = { ok: true } | { ok: false; error: string }

export type GlossEvent =
  | { type: 'session'; session: Session }
  /** `deletedOutside`: the agent no longer had it, so Gloss deleted it too (SPEC → Shared sessions). */
  | { type: 'sessionDeleted'; sessionId: string; deletedOutside?: { title: string } }
  /** `/clear` emptied the session: its messages, tool calls and threads are gone. */
  | { type: 'sessionCleared'; sessionId: string }
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
      /** A queued message starts right away. */
      continues?: true
    }
  | { type: 'queue'; sessionId: string; queue: MessageQueue }
  /** Something the user should know that is not part of the conversation, shown in `threadId`. */
  | { type: 'notice'; sessionId: string; threadId: string | null; text: string }
  | { type: 'authRequired'; agentId: string; agentName: string; methods: AuthMethodInfo[] }
  | { type: 'authResolved'; agentId: string }
  | { type: 'settings'; state: SettingsState }

export type GlossApi = {
  agents: {
    list(): Promise<AgentInfo[]>
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
     * Opens one of the agent's sessions in Gloss: its history becomes the log, placed in threads by its tags.
     * `listedAt` (the agent's `updatedAt` in its listing) stands in for when it was made, so it keeps its place.
     */
    import(cwd: string, agentId: string, acpSessionId: string, title: string, listedAt?: string): Promise<Session>
    /** Its log and threads. Also resumes the session on the agent in the background, for the status line. */
    open(id: string): Promise<SessionView>
    /** Reloads the session if the agent's copy changed elsewhere (SPEC → Shared sessions). */
    refresh(id: string): Promise<void>
    rename(id: string, title: string): Promise<Session>
    /** Deletes it from Gloss and the agent. Resolves to a warning if the agent's copy couldn't be deleted. */
    delete(id: string): Promise<string | null>
    /** Picks the session's model or effort. */
    setChoice(id: string, kind: 'model' | 'effort', value: string): Promise<void>
    /** Copies the session (or one thread) as markdown to the clipboard. */
    copyMarkdown(id: string, threadId: string | null): Promise<void>
    /** Saves the session (or one thread) as a markdown file. Resolves to false if cancelled. */
    saveMarkdown(id: string, threadId: string | null): Promise<boolean>
    /** Opens the session's folder in the system file manager. Resolves to an error message, or null. */
    openFolder(id: string): Promise<string | null>
    /** Plan usage from the session's agent, for the usage popup. Null if the agent can't be asked. */
    planUsage(id: string): Promise<PlanUsage | null>
  }
  git: {
    /** The folder's branch and whether it has uncommitted changes; null outside a repo. */
    status(cwd: string): Promise<GitStatus | null>
    /** The branch's pull request; null without one, or without `gh` or its login. */
    pullRequest(cwd: string): Promise<PullRequest | null>
  }
  threads: {
    /** Creates the thread for an anchor, or returns the existing one for the same anchor. */
    create(sessionId: string, anchorMessageId: string, anchor: Anchor): Promise<Thread>
  }
  /** Resolves when the turn ends, or right away with `queued` if a turn is running (SPEC → Queue). */
  send(sessionId: string, text: string, threadId: string | null, attachments: Attachment[]): Promise<TurnResult>
  /**
   * Injects a message into the running turn, which must be in `threadId` (SPEC → Steer).
   * Sent as usual when idle; queued first if the turn is just ending.
   */
  steer(sessionId: string, text: string, threadId: string | null, attachments: Attachment[]): Promise<TurnResult>
  cancel(sessionId: string): Promise<void>
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
    get(): Promise<SettingsState>
    /** Writes the changed keys to settings.json, keeping everything else. Rejects if the file isn't valid JSON. */
    update(patch: SettingsPatch): Promise<SettingsState>
    /** Opens settings.json in the system's editor for JSON. Resolves to an error message, or null. */
    openFile(): Promise<string | null>
  }
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: GlossEvent) => void): () => void
}

export const IPC = {
  agentsList: 'gloss:agents:list',
  projectsList: 'gloss:projects:list',
  projectsOpen: 'gloss:projects:open',
  projectsAgentSessions: 'gloss:projects:agentSessions',
  projectsDelete: 'gloss:projects:delete',
  sessionsList: 'gloss:sessions:list',
  sessionsCreate: 'gloss:sessions:create',
  sessionsImport: 'gloss:sessions:import',
  sessionsOpen: 'gloss:sessions:open',
  sessionsRefresh: 'gloss:sessions:refresh',
  sessionsRename: 'gloss:sessions:rename',
  sessionsDelete: 'gloss:sessions:delete',
  sessionsSetChoice: 'gloss:sessions:setChoice',
  sessionsCopyMarkdown: 'gloss:sessions:copyMarkdown',
  sessionsSaveMarkdown: 'gloss:sessions:saveMarkdown',
  sessionsOpenFolder: 'gloss:sessions:openFolder',
  sessionsPlanUsage: 'gloss:sessions:planUsage',
  gitStatus: 'gloss:git:status',
  gitPullRequest: 'gloss:git:pullRequest',
  threadsCreate: 'gloss:threads:create',
  send: 'gloss:send',
  steer: 'gloss:steer',
  cancel: 'gloss:cancel',
  queueEdit: 'gloss:queue:edit',
  queueRemove: 'gloss:queue:remove',
  queueResume: 'gloss:queue:resume',
  authSignIn: 'gloss:auth:signIn',
  authDismiss: 'gloss:auth:dismiss',
  settingsGet: 'gloss:settings:get',
  settingsUpdate: 'gloss:settings:update',
  settingsOpenFile: 'gloss:settings:openFile',
  event: 'gloss:event'
} as const
