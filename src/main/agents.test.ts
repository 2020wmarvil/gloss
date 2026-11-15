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
      { id: 'codex', name: 'Codex' },
      { id: 'antigravity', name: 'Antigravity' },
      { id: 'opencode', name: 'OpenCode' }
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
    const claude = {
      systemPrompt: { append: AGENT_INSTRUCTIONS },
      // Claude Code's own messages say what runs in the background (SPEC → Background jobs).
      claudeCode: {
        emitRawSDKMessages: [
          { type: 'system', subtype: 'background_tasks_changed' },
          { type: 'system', subtype: 'session_state_changed' }
        ]
      }
    }
    expect(getAgentConfig('claude').sessionMeta?.(AGENT_INSTRUCTIONS)).toEqual({ new: claude, load: claude })
    // Codex keeps them in the thread; its session/load ignores them.
    expect(getAgentConfig('codex').sessionMeta?.(AGENT_INSTRUCTIONS)).toEqual({
      new: { jetbrains: { air: { customInstructions: AGENT_INSTRUCTIONS } } }
    })
    const antigravity = { antigravity: { systemPrompt: { append: AGENT_INSTRUCTIONS } } }
    expect(getAgentConfig('antigravity').sessionMeta?.(AGENT_INSTRUCTIONS)).toEqual({ new: antigravity, load: antigravity })
  })

  it('runs the Antigravity CLI as its own ACP server, starting sessions in Auto', () => {
    const agy = getAgentConfig('antigravity')
    expect(agy.args).toEqual(['acp'])
    expect(agy.cli).toEqual({ kind: 'antigravity' })
    expect(agy.bypassModeId).toBeUndefined()
    expect(agy.startModeId).toBe('auto')
    expect(agy.listsAllSessions).toBe(true)
  })
})
