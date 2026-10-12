// Agent configurations. A small table so more ACP agents can be added later.

export type AgentConfig = {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

/** The model the dev toggle selects. The Claude adapter reads ANTHROPIC_MODEL. */
export const DEV_MODEL = 'haiku'

/**
 * Claude Code through its ACP adapter (@agentclientprotocol/claude-agent-acp).
 * The adapter is a Node script; we run it with Electron's own Node runtime
 * (ELECTRON_RUN_AS_NODE) so users don't need a separate Node install.
 */
function claudeAgent(): AgentConfig {
  return {
    id: 'claude',
    name: 'Claude Code',
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

export function getAgentConfig(id: string): AgentConfig {
  if (id === 'claude') return claudeAgent()
  throw new Error(`Unknown agent: ${id}`)
}

/** Environment for a spawned agent process. */
export function agentEnv(
  config: AgentConfig,
  opts: { devModel: boolean },
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...config.env }
  if (opts.devModel) env.ANTHROPIC_MODEL = DEV_MODEL
  return env
}
