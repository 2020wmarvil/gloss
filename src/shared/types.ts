// The app's data model (see docs/SPEC.md → Data model).

export type Session = {
  id: string
  agentId: string
  acpSessionId: string
  cwd: string
  title: string
  createdAt: number
}

export type Message = {
  id: string
  sessionId: string
  /** Position in the session's linear log, shared with tool calls. */
  seq: number
  role: 'user' | 'agent'
  /** What the user sees (no wire tag). For agent messages, accumulated markdown. */
  text: string
  /** User messages: exactly what was sent to the agent. */
  wireText?: string
  /** null = main thread. */
  threadId: string | null
  acpMessageId?: string
}

export type ToolCall = {
  /** ACP toolCallId. */
  id: string
  sessionId: string
  /** Ordering relative to messages. */
  messageSeq: number
  threadId: string | null
  title: string
  kind?: string
  /** pending | in_progress | completed | failed | cancelled */
  status: string
  content?: unknown
}

export type Anchor =
  /** path [2] = the 3rd top-level list item of the message. */
  | { kind: 'listItem'; path: number[]; text: string }
  /** Offsets into the message's source markdown. */
  | { kind: 'selection'; start: number; end: number; text: string }

export type Thread = {
  id: string
  sessionId: string
  /** The agent message the anchor lives in (any thread). */
  anchorMessageId: string
  anchor: Anchor
  createdAt: number
}

export type AgentInfo = { id: string; name: string }

export type AuthMethodInfo = {
  id: string
  name: string
  description?: string
  /** 'agent': the agent signs in itself. 'terminal': Gloss runs a login command in a terminal. */
  kind: 'agent' | 'terminal'
}
