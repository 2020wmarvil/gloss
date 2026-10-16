import { describe, expect, it } from 'vitest'
import { AGENT_INSTRUCTIONS } from '../shared/wire'
import { agentEnv, getAgentConfig, listAgents, type AgentConfig } from './agents'

const config: AgentConfig = {
  id: 'test',
  name: 'Test',
  command: 'node',
  args: [],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

describe('agentEnv', () => {
  it('launches the bundled Codex adapter', () => {
    const codex = getAgentConfig('codex')
    expect(codex.command).toBe(process.execPath)
    expect(codex.args).toEqual([require.resolve('@agentclientprotocol/codex-acp/dist/index.js')])
    expect(codex.bypassModeId).toBe('agent-full-access')
    expect(agentEnv(codex, {})).toEqual({ ELECTRON_RUN_AS_NODE: '1', DISABLE_MCP_CONFIG_FILTERING: 'true' })
    expect(listAgents()).toEqual([
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' }
    ])
  })

  it("adds the agent's environment to the inherited one", () => {
    const env = agentEnv(config, { PATH: '/bin', ANTHROPIC_MODEL: 'haiku' })
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_MODEL: 'haiku', ELECTRON_RUN_AS_NODE: '1' })
  })

  it("turns on Claude Code's todo tools, so it reports plans", () => {
    expect(agentEnv(getAgentConfig('claude'), {}).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
  })

  it("gives each agent Gloss's instructions in the form it takes them", () => {
    const claude = { systemPrompt: { append: AGENT_INSTRUCTIONS } }
    expect(getAgentConfig('claude').sessionMeta?.(AGENT_INSTRUCTIONS)).toEqual({ new: claude, load: claude })
    // Codex keeps them in the thread; its session/load ignores them.
    expect(getAgentConfig('codex').sessionMeta?.(AGENT_INSTRUCTIONS)).toEqual({
      new: { jetbrains: { air: { customInstructions: AGENT_INSTRUCTIONS } } }
    })
  })
})
