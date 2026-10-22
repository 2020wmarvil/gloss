import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profileError, profilesError, type AgentProfile } from '../shared/agentProfiles'
import { AgentProfileSupport } from './agentProfiles'
import { AgentConnection } from './acp'
import { agentEnv } from './agents'
import { SettingsFile, parseSettings, patchArg, settingsSchema } from './settings'
import { Store } from './db'
import { SessionManager } from './sessions'
import type { GlossEvent } from '../shared/ipc'

const defaults = { defaultAgent: 'claude', theme: 'system' as const, sessionOrder: 'created' as const, listItemReplies: false, turnEndSound: true, externalEditor: '', mcpServers: [] }
const profile: AgentProfile = { id: 'custom:test', name: 'Test agent', command: process.execPath, args: [resolve('src/main/fixtures/profile-agent.mjs'), '{instructions}'], env: { GLOSS_PROFILE_DATA: 'GLOSS_TEST_DATA', GLOSS_TEST_SECRET: 'GLOSS_PROFILE_SECRET' } }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gloss-profile-'))
  vi.stubEnv('GLOSS_TEST_DATA', dir)
  vi.stubEnv('GLOSS_PROFILE_SECRET', 'test-secret-never-display')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('agent profile settings', () => {
  it('validates IDs, environment references, instruction delivery and duplicates', () => {
    expect(profileError(profile)).toBeNull()
    expect(profileError({ ...profile, id: 'claude' })).toMatch(/ID/)
    expect(profileError({ ...profile, args: 'acp' })).toMatch(/array/)
    expect(profileError({ ...profile, env: { KEY: 'secret-value' } })).toMatch(/references/)
    expect(profileError({ ...profile, args: [] })).toMatch(/instructions/)
    expect(profileError({ ...profile, instructionsEnv: 'BAD-NAME' })).toMatch(/variable name/)
    expect(profilesError([profile, profile])).toMatch(/unique/)
    expect(() => patchArg({ global: { agentProfiles: [{ ...profile, args: [] }] } })).toThrow(/instructions/)
    expect(parseSettings(JSON.stringify({ defaultAgent: profile.id, agentProfiles: [profile] }), defaults)).toMatchObject({ ok: true })
    expect(settingsSchema(defaults)).toHaveProperty('properties.agentProfiles.items.required')
  })

  it('persists profile IDs and references across restart and allows restoring a removed profile', () => {
    const settings = new SettingsFile({ dir, defaults })
    settings.load()
    settings.update(patchArg({ global: { agentProfiles: [profile], defaultAgent: profile.id } }))
    const reopened = new SettingsFile({ dir, defaults })
    expect(reopened.load().global).toMatchObject({ agentProfiles: [profile], defaultAgent: profile.id })
    reopened.update({ global: { agentProfiles: [], defaultAgent: 'claude' } })
    expect(reopened.state().global.agentProfiles).toEqual([])
    reopened.update({ global: { agentProfiles: [profile] } })
    expect(readFileSync(reopened.path, 'utf8')).not.toContain('test-secret-never-display')
  })
})

describe('custom agent connection', () => {
  it('reports capabilities without creating a session or calling a model', async () => {
    const support = new AgentProfileSupport(join(dir, 'gloss'))
    expect(await support.check(profile)).toMatchObject({ available: true, version: '1.0.0', capabilities: { resume: true, discovery: true, images: true, context: true, steering: false } })
    expect(readdirSync(dir)).toEqual(['gloss'])
  })

  it('uses argument arrays and environment references and writes instructions only in Gloss data', () => {
    const support = new AgentProfileSupport(join(dir, 'gloss'))
    const config = support.config(profile)
    expect(config.env?.GLOSS_TEST_SECRET).toBe('test-secret-never-display')
    expect(config.args[1]).toBe(join(dir, 'gloss', 'custom-test-instructions.md'))
    expect(readFileSync(config.args[1], 'utf8')).toContain('[re:')
    const envConfig = support.config({ ...profile, args: [], instructionsEnv: 'INSTRUCTION_FILE' })
    expect(envConfig.env?.INSTRUCTION_FILE).toBe(config.args[1])
    expect(readdirSync(dir)).toEqual(['gloss'])
  })

  it('reports missing environment variables, executable failures and incompatible ACP without secrets', async () => {
    const support = new AgentProfileSupport(join(dir, 'gloss'))
    expect(await support.check({ ...profile, env: { KEY: 'GLOSS_NONEXISTENT_PROFILE_VARIABLE' } })).toMatchObject({ available: false, error: expect.stringContaining('is missing') })
    expect(await support.check({ ...profile, command: join(dir, 'missing-executable') })).toMatchObject({ available: false, error: expect.stringContaining('Could not start') })
    vi.stubEnv('GLOSS_BAD_VERSION', '1')
    expect(await support.check({ ...profile, env: { ...profile.env, GLOSS_BAD_PROTOCOL: 'GLOSS_BAD_VERSION' } })).toMatchObject({ available: false, error: expect.stringContaining('Unsupported ACP protocol') })
  })

  it('bounds initialization and suppresses raw protocol error payloads', async () => {
    vi.stubEnv('GLOSS_INIT_FLAG', '1')
    const support = new AgentProfileSupport(join(dir, 'gloss'), (config, env, handlers) => AgentConnection.start({ ...config, startupTimeoutMs: 200 }, env, handlers))
    expect(await support.check({ ...profile, env: { ...profile.env, GLOSS_HANG_INIT: 'GLOSS_INIT_FLAG' } })).toMatchObject({ available: false, error: expect.stringContaining('timed out') })
    const failed = await support.check({ ...profile, env: { ...profile.env, GLOSS_FAIL_INIT: 'GLOSS_INIT_FLAG' } })
    expect(failed.available).toBe(false)
    expect(JSON.stringify(failed)).not.toContain('test-secret-never-display')
  })

  it('preserves the authentication error code while redacting its payload', async () => {
    const config = new AgentProfileSupport(join(dir, 'gloss')).config(profile)
    const conn = await AgentConnection.start(config, agentEnv(config), {
      onUpdate() {}, onStderr() {}, onClosed() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } })
    })
    try {
      const session = await conn.newSession(dir)
      await expect(conn.prompt(session.sessionId, [{ type: 'text', text: 'auth-error' }])).rejects.toMatchObject({ code: -32000, message: expect.stringContaining('Custom agent request failed') })
    } finally { conn.dispose() }
  })

  it('runs threaded turns, file edits, cancellation and restart in the same checkout; preserves removed-profile history', async () => {
    const cwd = join(dir, 'project')
    mkdirSync(cwd)
    const support = new AgentProfileSupport(join(dir, 'gloss'))
    const store = new Store(join(dir, 'gloss.db'))
    const events: GlossEvent[] = []
    let installed = true
    const makeManager = (): SessionManager => new SessionManager({
      store, emit: (event) => events.push(event),
      getAgentConfig: () => {
        if (!installed) throw new Error('Restore the removed profile with the same ID in Settings > Agents.')
        return support.config(profile)
      },
      agentEnv, connect: (c, e, h) => AgentConnection.start(c, e, h), runInTerminal: async () => 0
    })
    let manager = makeManager()
    try {
      const session = await manager.createSession(cwd, profile.id)
      expect(await manager.send(session.id, 'hello', null)).toMatchObject({ stopReason: 'end_turn' })
      const answer = store.listMessages(session.id).find((m) => m.role === 'agent')!
      expect(answer.text).toContain('Instructions loaded')
      const thread = manager.createThread(session.id, answer.id, { kind: 'selection', start: 0, end: 12, text: 'Instructions' })
      await manager.send(session.id, 'why?', thread.id)
      expect(store.listMessages(session.id).at(-1)).toMatchObject({ role: 'agent', threadId: thread.id, text: expect.stringContaining('[re:') })
      await manager.send(session.id, 'write-file', null)
      expect(readFileSync(join(cwd, 'profile-result.txt'), 'utf8')).toContain('custom ACP profile')
      expect(store.listToolCalls(session.id)).toContainEqual(expect.objectContaining({ status: 'completed' }))
      const failed = await manager.send(session.id, 'fail-secret', null)
      expect(failed.error).toContain('Custom agent request failed')
      expect(JSON.stringify(events)).not.toContain('test-secret-never-display')
      const pending = manager.send(session.id, 'hold', null)
      await vi.waitFor(() => expect(store.listToolCalls(session.id)).toContainEqual(expect.objectContaining({ title: 'Waiting for cancellation', status: 'in_progress' })))
      expect(await manager.restartIdleAgent(profile.id)).toBe(false)
      await manager.cancel(session.id)
      expect(await pending).toMatchObject({ stopReason: 'cancelled' })
      await manager.dispose()
      installed = false
      manager = makeManager()
      const view = manager.openSession(session.id)
      expect(view.session).toMatchObject({ cwd, agentId: profile.id })
      expect(view.threads).toContainEqual(thread)
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'notice', text: expect.stringContaining('Restore') })))
      installed = true
      expect(await manager.send(session.id, 'restored', thread.id)).toMatchObject({ stopReason: 'end_turn' })
      expect(store.getSession(session.id)?.acpSessionId).toBe(session.acpSessionId)
      expect(store.listMessages(session.id).at(-1)?.threadId).toBe(thread.id)
    } finally { await manager.dispose(); store.close() }
  })
})
