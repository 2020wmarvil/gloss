import { describe, expect, it } from 'vitest'
import { agentEnv, DEV_MODEL, getAgentConfig, listAgents, type AgentConfig } from './agents'

const config: AgentConfig = {
  id: 'test',
  name: 'Test',
  command: 'node',
  args: [],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  devModelEnv: { ANTHROPIC_MODEL: DEV_MODEL }
}

describe('agentEnv', () => {
  it('launches the bundled Codex adapter without the Claude dev override', () => {
    const codex = getAgentConfig('codex')
    expect(codex.command).toBe(process.execPath)
    expect(codex.args).toEqual([require.resolve('@agentclientprotocol/codex-acp/dist/index.js')])
    expect(codex.bypassModeId).toBe('agent-full-access')
    expect(agentEnv(codex, { devModel: true }, {})).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(listAgents()).toEqual([
      { id: 'claude', name: 'Claude Code', hasDevModel: true },
      { id: 'codex', name: 'Codex', hasDevModel: false }
    ])
  })
  it('sets ANTHROPIC_MODEL when the dev model is on', () => {
    const env = agentEnv(config, { devModel: true }, { PATH: '/bin' })
    expect(env.ANTHROPIC_MODEL).toBe(DEV_MODEL)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.PATH).toBe('/bin')
  })

  it('leaves the inherited model alone when the dev model is off', () => {
    expect(agentEnv(config, { devModel: false }, {}).ANTHROPIC_MODEL).toBeUndefined()
    expect(agentEnv(config, { devModel: false }, { ANTHROPIC_MODEL: 'opus' }).ANTHROPIC_MODEL).toBe(
      'opus'
    )
  })

  it("turns on Claude Code's todo tools, so it reports plans", () => {
    expect(agentEnv(getAgentConfig('claude'), { devModel: false }, {}).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
  })
})
