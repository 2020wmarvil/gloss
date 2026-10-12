import { describe, expect, it } from 'vitest'
import { agentEnv, DEV_MODEL, type AgentConfig } from './agents'

const config: AgentConfig = {
  id: 'test',
  name: 'Test',
  command: 'node',
  args: [],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

describe('agentEnv', () => {
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
})
