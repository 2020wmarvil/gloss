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
  threads: Thread[]
  /** The running turn, if any. */
  turn: { threadId: string | null } | null
  queue: MessageQueue
  live: SessionLive
}

export type GitStatus = { branch: string; dirty: boolean }

/**
 * `queued`: a turn was running, so the message was queued instead of sent.
 * `steered`: the message was injected into the running turn.
 * `cleared`: it was `/clear`, which Gloss ran itself.
 */
export type TurnResult = { stopReason?: string; error?: string; queued?: true; steered?: true; cleared?: true }

export type AuthResult = { ok: true } | { ok: false; error: string }

export type GlossEvent =
  | { type: 'session'; session: Session }
  | { type: 'sessionDeleted'; sessionId: string }
  /** `/clear` emptied the session: its messages, tool calls and threads are gone. */
  | { type: 'sessionCleared'; sessionId: string }
  | { type: 'live'; sessionId: string; live: SessionLive }
  /** The user clicked a notification: show this session (and thread). */
  | { type: 'reveal'; sessionId: string; threadId: string | null }
  | { type: 'message'; message: Message }
  /** A steered message that didn't get into the turn (SPEC → Steer). */
  | { type: 'messageDeleted'; sessionId: string; messageId: string }
  | { type: 'toolCall'; toolCall: ToolCall }
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
    /** The agent's own sessions in the folder that Gloss hasn't imported. Empty if the agent can't list them. */
    agentSessions(path: string, agentId: string): Promise<AgentSession[]>
    /** Deletes the project and its sessions (the agent's copies too). Resolves to a warning if some agent copies couldn't be deleted. */
    delete(path: string): Promise<string | null>
  }
  sessions: {
    list(): Promise<Session[]>
    /** Starts an agent session in `cwd`. Rejects if the agent can't start one. */
    create(cwd: string, agentId: string): Promise<Session>
    /** Imports one of the agent's sessions: its history becomes the main thread. */
    import(cwd: string, agentId: string, acpSessionId: string, title: string): Promise<Session>
    /** Also resumes the session on the agent in the background, for the status line. */
    open(id: string): Promise<SessionView>
    rename(id: string, title: string): Promise<Session>
    /** Deletes it from Gloss and the agent. Resolves to a warning if the agent's copy couldn't be deleted. */
    delete(id: string): Promise<string | null>
    setModel(id: string, value: string): Promise<void>
    /** Copies the session (or one thread) as markdown to the clipboard. */
    copyMarkdown(id: string, threadId: string | null): Promise<void>
    /** Saves the session (or one thread) as a markdown file. Resolves to false if cancelled. */
    saveMarkdown(id: string, threadId: string | null): Promise<boolean>
  }
  git: {
    /** The folder's branch and whether it has uncommitted changes; null outside a repo. */
    status(cwd: string): Promise<GitStatus | null>
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
  sessionsRename: 'gloss:sessions:rename',
  sessionsDelete: 'gloss:sessions:delete',
  sessionsSetModel: 'gloss:sessions:setModel',
  sessionsCopyMarkdown: 'gloss:sessions:copyMarkdown',
  sessionsSaveMarkdown: 'gloss:sessions:saveMarkdown',
  gitStatus: 'gloss:git:status',
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
