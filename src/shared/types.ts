// The app's data model (see docs/SPEC.md → Data model).

export type Session = {
  id: string
  agentId: string
  acpSessionId: string
  cwd: string
  /** Renamed in Gloss (`titleSet`), else the agent's title, else the first message or the folder name. */
  title: string
  /** The user renamed it in Gloss: the agent's title doesn't replace it. */
  titleSet?: true
  createdAt: number
  /** The newest message's time, else `createdAt`. Sorts the session list. */
  activeAt?: number
  /** The model picked for this session in Gloss (a model config option value), re-applied when it is resumed. */
  model?: string
  /** The effort picked for this session in Gloss (a thought_level config option value), re-applied likewise. */
  effort?: string
  /** The agent's `updatedAt` for the session when Gloss last synced it (SPEC → Shared sessions). */
  syncedAt?: string
}

/** An image or file sent with a user message (SPEC → Attachments). */
export type Attachment =
  /** `data` is base64. */
  | { kind: 'image'; name: string; mimeType: string; data: string }
  /** A text file, sent as embedded context. */
  | { kind: 'file'; name: string; path?: string; mimeType?: string; text: string }

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
  /** User messages: images and files sent with it. */
  attachments?: Attachment[]
  /** User messages: injected into a running turn instead of starting one (SPEC → Steer). */
  steered?: true
  /** When it was recorded, ms since the epoch. Missing on messages stored before M9. */
  createdAt?: number
  /** User messages: how the turn they were sent in ended. Missing while it runs, and for turns Gloss didn't run. */
  outcome?: TurnOutcome
}

/** How a turn ended: `failed` covers errors and turns cut short (max tokens, refusal). */
export type TurnOutcome = 'completed' | 'cancelled' | 'failed'

/** A message sent while a turn was running, waiting for its turn (SPEC → Queue). Kept in memory only. */
export type QueuedMessage = {
  id: string
  /** The thread it was written in; it runs there. null = main thread. */
  threadId: string | null
  text: string
  attachments: Attachment[]
}

/** A session's queued messages, sent in order as turns end. */
export type MessageQueue = {
  items: QueuedMessage[]
  /** A turn was cancelled, failed or stopped early: nothing more is sent until the user resumes or a turn ends normally. */
  paused: boolean
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

export type PlanEntry = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: string
}

/** The agent's plan for one turn, shown as a checklist in its thread (SPEC → Plans). */
export type Plan = {
  id: string
  sessionId: string
  /** Where it first appeared in the turn; shares the log's sequence with messages and tool calls. */
  seq: number
  threadId: string | null
  /** The whole plan, as of the agent's latest update. */
  entries: PlanEntry[]
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

/** A folder Gloss groups sessions by. */
export type Project = { path: string; name: string }

/** One of the agent's own sessions for a folder that Gloss has no record of yet. */
export type AgentSession = { acpSessionId: string; title: string; updatedAt?: string }

export type ModelOption = { value: string; name: string; description?: string }

/** One of the agent's select config options (model, effort), flattened. */
export type ConfigChoice = { configId: string; current: string; options: ModelOption[] }

export type SlashCommand = { name: string; description: string; hint?: string }

/** One plan usage window, e.g. Claude's 5-hour or weekly limit. */
export type RateLimit = {
  /** The agent's name for the window, e.g. "five_hour", "seven_day", "seven_day_opus". */
  window: string
  status: 'allowed' | 'warning' | 'rejected'
  /** Percent used, when the agent says (Claude Code only does near the limit). */
  utilization?: number
  /** When the window resets, ms since the epoch. */
  resetsAt?: number
}

/** Plan usage the usage popup asks the agent for (Claude Code's `/usage` data). */
export type PlanUsage = {
  /** The subscription, e.g. "Pro"; null without one. */
  plan: string | null
  /** False when plan limits don't apply (an API key, Bedrock, Vertex). */
  available: boolean
  /** Each window with a known percentage: "Session limit", "Weekly · all models", per model. */
  limits: { label: string; percent: number; resetsAt: number | null }[]
  /** Usage past the plan limits, when turned on. */
  extraUsage: { percent: number | null } | null
}

/** What the agent reports about a session while it is attached: shown in the status line. */
export type SessionLive = {
  /** The session's ACP session is live on a running agent. */
  attached: boolean
  /** The agent's model config option, if it has one. */
  model: ConfigChoice | null
  /** The agent's effort config option (category thought_level), if the model has one. */
  effort: ConfigChoice | null
  commands: SlashCommand[]
  /** Context window use, from the agent's usage updates. */
  usage: { used: number; size: number; cost?: { amount: number; currency: string } } | null
  /** Plan usage limits, per window, when the agent reports them (Claude Code does, in usage updates). */
  rateLimits: RateLimit[]
  /** 'bypass': the agent's bypass mode is on. 'auto': Gloss auto-approves permission requests instead. */
  permissions: 'bypass' | 'auto' | null
  /** What the agent accepts in a prompt besides text. */
  accepts: { image: boolean; file: boolean }
  /** The agent takes messages into a running turn (SPEC → Steer). */
  steering: boolean
}

export type AuthMethodInfo = {
  id: string
  name: string
  description?: string
  /** 'agent': the agent signs in itself. 'terminal': Gloss runs a login command in a terminal. */
  kind: 'agent' | 'terminal'
}
