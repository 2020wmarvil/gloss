// Agent configurations. A small table so more ACP agents can be added later.

export type AgentConfig = {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  /**
   * The agent's session mode that skips permission prompts, if it has one.
   * Gloss switches every session to it (SPEC → Permissions).
   */
  bypassModeId?: string
}

/**
 * Claude Code through its ACP adapter (@agentclientprotocol/claude-agent-acp).
 * The adapter is a Node script; we run it with Electron's own Node runtime
 * (ELECTRON_RUN_AS_NODE) so users don't need a separate Node install.
 * Claude Code gives only older models its todo tools unless
 * CLAUDE_CODE_ENABLE_TODO_TOOLS is set; with them it reports plans (SPEC → Plans).
 */
function claudeAgent(): AgentConfig {
  return {
    id: 'claude',
    name: 'Claude Code',
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    bypassModeId: 'bypassPermissions'
  }
}

const AGENTS: Record<string, () => AgentConfig> = {
  claude: claudeAgent,
  codex: () => ({
    id: 'codex',
    name: 'Codex',
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    bypassModeId: 'agent-full-access'
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
