// Agent configurations. A small table so more ACP agents can be added later.
import type { CliKind } from './agentCli'

export type AgentConfig = {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Bound initialization for external executables. */
  startupTimeoutMs?: number
  /** The agent process's working folder; Gloss's own when unset. Antigravity makes it a workspace folder of every session. */
  cwd?: string
  /** External profiles never expose arbitrary process or protocol diagnostics. */
  privateDiagnostics?: boolean
  /**
   * The user-installed CLI (SPEC → Shipping): Gloss finds it before starting the agent and
   * passes its path to the adapter in `env`, or, without `env`, runs it as the agent.
   */
  cli?: { kind: CliKind; env?: string }
  /**
   * The agent's session mode that skips permission prompts, if it has one.
   * Sessions start in it by default (SPEC → Permission modes).
   */
  bypassModeId?: string
  /**
   * For an agent without a bypass mode: the mode sessions start in when the permission setting
   * is bypass, instead of Gloss approving requests itself (SPEC → Permission modes).
   */
  startModeId?: string
  /**
   * `_meta` for session/new and session/load that gives the agent Gloss's
   * instructions (SPEC → Agent instructions), in whatever form it takes them.
   */
  sessionMeta?(instructions: string): { new?: Record<string, unknown>; load?: Record<string, unknown> }
  /**
   * A tool call still `in_progress` when a turn ends normally is a job running in the
   * background, and its end comes later (SPEC → Background jobs).
   */
  toolCallsOutliveTurns?: boolean
  /**
   * The agent runs sub-agents in child sessions of their own when the client declares the
   * draft ACP `subagents` capability (SPEC → Sub-agents). Declared only for agents that do.
   */
  subagents?: boolean
  /**
   * The tool result that says a job went to the background, for an agent that reports nothing
   * more about it over ACP. Its end is worked out from the session's history (SPEC → Background jobs).
   */
  quietJobResult?: RegExp
  /** The title of a tool call that hands work to the background, for an agent that says nothing more about it. */
  quietJobTitle?: RegExp
  /**
   * A tool call still `in_progress` when a turn ends normally is a job running in the background,
   * and the agent says nothing more about it over ACP: its end comes from the session's history.
   */
  quietToolCallsOutliveTurns?: boolean
  /** session/list answers with the agent's sessions in every folder, whatever `cwd` asks for. */
  listsAllSessions?: boolean
  /**
   * Runs once the agent has started. A returned config replaces the running agent with one
   * started from it, once (Codex's plugin hooks: SPEC → Plugins → Subagents and hooks).
   */
  afterStart?(conn: { extRequest(method: string, params: Record<string, unknown>): Promise<unknown> }): Promise<AgentConfig | undefined>
}

/**
 * The Claude adapter answers session/prompt while background tasks run on and reports them
 * to no ACP v1 client, so Gloss asks for Claude Code's own messages (SPEC → Background jobs).
 */
const CLAUDE_MESSAGES = [
  { type: 'system', subtype: 'background_tasks_changed' },
  { type: 'system', subtype: 'session_state_changed' }
]

/**
 * Claude Code through its ACP adapter (@agentclientprotocol/claude-agent-acp).
 * The adapter is a Node script; we run it with Electron's own Node runtime
 * (ELECTRON_RUN_AS_NODE) so users don't need a separate Node install.
 * Claude Code gives only older models its todo tools unless
 * CLAUDE_CODE_ENABLE_TODO_TOOLS is set; with them it reports plans (SPEC → Plans).
 * The adapter appends `_meta.systemPrompt.append` to Claude Code's system prompt.
 * Claude Code keeps a session's system prompt from its creation (a resume ignores a
 * new one), but the adapter counts it in the session's fingerprint: a load without
 * it would restart a session the adapter already runs.
 */
function claudeAgent(): AgentConfig {
  return {
    id: 'claude',
    name: 'Claude Code',
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    cli: { kind: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
    bypassModeId: 'bypassPermissions',
    subagents: true,
    sessionMeta: (instructions) => ({
      new: { systemPrompt: { append: instructions }, claudeCode: { emitRawSDKMessages: CLAUDE_MESSAGES } },
      load: { systemPrompt: { append: instructions }, claudeCode: { emitRawSDKMessages: CLAUDE_MESSAGES } }
    })
  }
}

/**
 * Codex through its ACP adapter. It takes developer instructions only on session/new,
 * from JetBrains AIR's `customInstructions` key; Codex keeps them in the thread. (A
 * request's `_meta` doesn't make it treat Gloss as AIR: that comes from initialize.)
 */
function codexAgent(): AgentConfig {
  return {
    id: 'codex',
    name: 'Codex',
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')],
    // Let explicit Gloss entries override same-named native entries. Otherwise
    // codex-acp filters them out and later edits in Gloss never take effect.
    env: { ELECTRON_RUN_AS_NODE: '1', DISABLE_MCP_CONFIG_FILTERING: 'true' },
    cli: { kind: 'codex', env: 'CODEX_PATH' },
    bypassModeId: 'agent-full-access',
    toolCallsOutliveTurns: true,
    sessionMeta: (instructions) => ({ new: { jetbrains: { air: { customInstructions: instructions } } } })
  }
}

/**
 * Antigravity's CLI, which is its own ACP server (`agy acp`). It appends
 * `_meta.antigravity.systemPrompt.append` to its system prompt. It has no bypass mode (only a
 * launch flag), so sessions start in Auto. A long command it moves to the background stays
 * `in_progress` when the turn ends, and a subagent runs on after `invoke_subagent` completes;
 * neither reports more over ACP, so their end comes from `session/list`'s `updatedAt`.
 */
function antigravityAgent(): AgentConfig {
  const meta = (instructions: string): Record<string, unknown> => ({ antigravity: { systemPrompt: { append: instructions } } })
  return {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    args: ['acp'],
    startupTimeoutMs: 15000,
    cli: { kind: 'antigravity' },
    startModeId: 'auto',
    quietJobTitle: /^Run invoke_subagent$/,
    quietToolCallsOutliveTurns: true,
    listsAllSessions: true,
    sessionMeta: (instructions) => ({ new: meta(instructions), load: meta(instructions) })
  }
}

const AGENTS: Record<string, () => AgentConfig> = {
  claude: claudeAgent,
  codex: codexAgent,
  antigravity: antigravityAgent,
  opencode: () => ({
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    startupTimeoutMs: 15000,
    quietJobResult: /^(?:Command moved to the background|The subagent is working in the background)/
  })
}

export function getAgentConfig(id: string): AgentConfig {
  const make = AGENTS[id]
  if (!make) throw new Error(`Unknown agent: ${id}`)
  return make()
}

export function listAgents(): { id: string; name: string }[] {
  return Object.values(AGENTS).map((make) => {
    const { id, name } = make()
    return { id, name }
  })
}

/** Environment for a spawned agent process. */
export function agentEnv(config: AgentConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...config.env }
}
