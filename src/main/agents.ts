// Agent configurations. A small table so more ACP agents can be added later.

export type AgentConfig = {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Bound initialization for external executables. */
  startupTimeoutMs?: number
  /**
   * The agent's session mode that skips permission prompts, if it has one.
   * Gloss switches every session to it (SPEC → Permissions).
   */
  bypassModeId?: string
  /**
   * `_meta` for session/new and session/load that gives the agent Gloss's
   * instructions (SPEC → Agent instructions), in whatever form it takes them.
   */
  sessionMeta?(instructions: string): { new?: Record<string, unknown>; load?: Record<string, unknown> }
}

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
    bypassModeId: 'bypassPermissions',
    sessionMeta: (instructions) => ({
      new: { systemPrompt: { append: instructions } },
      load: { systemPrompt: { append: instructions } }
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
    bypassModeId: 'agent-full-access',
    sessionMeta: (instructions) => ({ new: { jetbrains: { air: { customInstructions: instructions } } } })
  }
}

const AGENTS: Record<string, () => AgentConfig> = {
  claude: claudeAgent,
  codex: codexAgent,
  opencode: () => ({ id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'], startupTimeoutMs: 15000 })
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
