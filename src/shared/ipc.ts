// The IPC contract between the main process and the renderer.
// Type-only (plus channel names): nothing here may pull runtime code into the sandboxed preload.
import type { AgentInfo, AuthMethodInfo, Message, Session, ToolCall } from './types'

export type Settings = {
  /** Spawn agents with ANTHROPIC_MODEL=haiku so development prompts are cheap. */
  devModel: boolean
}

export type SessionView = {
  session: Session
  messages: Message[]
  toolCalls: ToolCall[]
  /** The running turn, if any. */
  turn: { threadId: string | null } | null
}

export type TurnResult = { stopReason?: string; error?: string }

export type AuthResult = { ok: true } | { ok: false; error: string }

export type GlossEvent =
  | { type: 'session'; session: Session }
  | { type: 'message'; message: Message }
  | { type: 'toolCall'; toolCall: ToolCall }
  | { type: 'turnStart'; sessionId: string; threadId: string | null }
  | { type: 'turnEnd'; sessionId: string; stopReason?: string; error?: string }
  /** Something the user should know about a session that is not part of the conversation. */
  | { type: 'notice'; sessionId: string; text: string }
  | { type: 'authRequired'; agentId: string; agentName: string; methods: AuthMethodInfo[] }
  | { type: 'authResolved'; agentId: string }

export type GlossApi = {
  agents: {
    list(): Promise<AgentInfo[]>
  }
  sessions: {
    list(): Promise<Session[]>
    /** Starts an agent session in `cwd`. Rejects if the agent can't start one. */
    create(cwd: string, agentId: string): Promise<Session>
    open(id: string): Promise<SessionView>
  }
  /** Resolves when the turn ends. */
  send(sessionId: string, text: string, threadId: string | null): Promise<TurnResult>
  cancel(sessionId: string): Promise<void>
  auth: {
    signIn(agentId: string, methodId: string): Promise<AuthResult>
    dismiss(agentId: string): Promise<void>
  }
  dialog: {
    /** Native folder picker. Resolves to null if cancelled. */
    pickDirectory(): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    setDevModel(on: boolean): Promise<Settings>
  }
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: GlossEvent) => void): () => void
}

export const IPC = {
  agentsList: 'gloss:agents:list',
  sessionsList: 'gloss:sessions:list',
  sessionsCreate: 'gloss:sessions:create',
  sessionsOpen: 'gloss:sessions:open',
  send: 'gloss:send',
  cancel: 'gloss:cancel',
  authSignIn: 'gloss:auth:signIn',
  authDismiss: 'gloss:auth:dismiss',
  pickDirectory: 'gloss:dialog:pickDirectory',
  settingsGet: 'gloss:settings:get',
  settingsSetDevModel: 'gloss:settings:setDevModel',
  event: 'gloss:event'
} as const
