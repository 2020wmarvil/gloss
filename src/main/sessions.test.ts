import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import type { GlossEvent } from '../shared/ipc'
import { AgentConnection } from './acp'
import type { AgentConfig } from './agents'
import { Store } from './db'
import { SessionManager } from './sessions'

type Script = (ctx: {
  sessionId: string
  text: string
  say(text: string, messageId?: string): Promise<void>
  update(update: acp.SessionUpdate): Promise<void>
  cancelled: Promise<void>
}) => Promise<acp.StopReason>

/** State shared by every connection to the fake agent, like a real agent's disk state. */
type FakeAgent = {
  loadSession: boolean
  authMethods: acp.AuthMethod[]
  signedIn: boolean
  sessions: Set<string>
  prompts: string[]
  loads: string[]
  authenticated: string[]
  connections: number
  script: Script
}

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    loadSession: true,
    authMethods: [],
    signedIn: true,
    sessions: new Set(),
    prompts: [],
    loads: [],
    authenticated: [],
    connections: 0,
    script: async ({ say }) => {
      await say('Hello')
      await say(' world')
      return 'end_turn'
    },
    ...overrides
  }
}

function agentApp(state: FakeAgent): acp.AgentApp {
  state.connections++
  const cancels = new Map<string, () => void>()
  let next = 0
  return acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: state.loadSession },
      authMethods: state.authMethods
    }))
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      state.authenticated.push(ctx.params.methodId)
      state.signedIn = true
      return {}
    })
    .onRequest(acp.methods.agent.session.new, () => {
      const sessionId = `acp-${state.connections}-${next++}`
      state.sessions.add(sessionId)
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const { sessionId } = ctx.params
      state.loads.push(sessionId)
      if (!state.sessions.has(sessionId)) throw acp.RequestError.resourceNotFound(sessionId)
      // Replay history, as the Claude adapter does.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } }
      })
      return {}
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      cancels.get(ctx.params.sessionId)?.()
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      if (!state.signedIn) throw acp.RequestError.authRequired()
      const { sessionId } = ctx.params
      const block = ctx.params.prompt[0]
      const text = block.type === 'text' ? block.text : ''
      state.prompts.push(text)
      const update = (u: acp.SessionUpdate): Promise<void> =>
        ctx.client.notify(acp.methods.client.session.update, { sessionId, update: u })
      const cancelled = new Promise<void>((resolve) => cancels.set(sessionId, resolve))
      const stopReason = await state.script({
        sessionId,
        text,
        update,
        say: (t, messageId) =>
          update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: t },
            ...(messageId ? { messageId } : {})
          }),
        cancelled
      })
      return { stopReason }
    })
}

const config: AgentConfig = { id: 'fake', name: 'Fake Agent', command: 'fake-agent', args: ['--acp'] }

describe('SessionManager', () => {
  let store: Store
  let events: GlossEvent[]
  let state: FakeAgent
  let manager: SessionManager
  let runInTerminal: ReturnType<typeof vi.fn>

  function makeManager(): SessionManager {
    return new SessionManager({
      store,
      emit: (e) => events.push(e),
      getAgentConfig: () => config,
      agentEnv: () => ({ FAKE: '1' }),
      connect: (_config, _env, handlers) => AgentConnection.open(agentApp(state), handlers),
      runInTerminal: runInTerminal as never,
      now: () => 1000
    })
  }

  beforeEach(() => {
    store = new Store(':memory:')
    events = []
    state = fakeAgent()
    runInTerminal = vi.fn(async () => 0)
    manager = makeManager()
  })

  afterEach(async () => {
    await manager.dispose()
    store.close()
  })

  it('creates a session, streams a turn and persists it', async () => {
    const session = await manager.createSession('/work/shop', 'fake')
    expect(session).toMatchObject({ agentId: 'fake', cwd: '/work/shop', title: 'shop' })
    expect(manager.listSessions()).toEqual([session])

    const result = await manager.send(session.id, 'Review the order service', null)
    expect(result).toEqual({ stopReason: 'end_turn' })
    expect(state.prompts).toEqual(['Review the order service'])

    const view = manager.openSession(session.id)
    expect(view.session.title).toBe('Review the order service')
    expect(view.turn).toBeNull()
    expect(view.messages.map((m) => [m.seq, m.role, m.text, m.threadId])).toEqual([
      [0, 'user', 'Review the order service', null],
      [1, 'agent', 'Hello world', null]
    ])
    expect(view.messages[0].wireText).toBe('Review the order service')

    const types = events.map((e) => e.type)
    expect(types.indexOf('turnStart')).toBeLessThan(types.indexOf('turnEnd'))
    expect(events.at(-1)).toEqual({ type: 'turnEnd', sessionId: session.id, stopReason: 'end_turn' })
  })

  it('orders text and tool calls in one sequence, splitting text at tool calls', async () => {
    state.script = async ({ say, update }) => {
      await say('Let me look.')
      await update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read orders.ts', kind: 'read', status: 'pending' })
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
      await say('Found it.')
      return 'end_turn'
    }
    const session = await manager.createSession('/w', 'fake')
    await manager.send(session.id, 'go', null)

    const view = manager.openSession(session.id)
    expect(view.messages.map((m) => [m.seq, m.text])).toEqual([
      [0, 'go'],
      [1, 'Let me look.'],
      [3, 'Found it.']
    ])
    expect(view.toolCalls).toEqual([
      {
        id: 't1',
        sessionId: session.id,
        messageSeq: 2,
        threadId: null,
        title: 'Read orders.ts',
        kind: 'read',
        status: 'completed'
      }
    ])
  })

  it('starts a new agent message when the ACP messageId changes', async () => {
    state.script = async ({ say }) => {
      await say('one', 'm1')
      await say(' more', 'm1')
      await say('two', 'm2')
      return 'end_turn'
    }
    const session = await manager.createSession('/w', 'fake')
    await manager.send(session.id, 'go', null)
    const agentMessages = manager.openSession(session.id).messages.filter((m) => m.role === 'agent')
    expect(agentMessages.map((m) => [m.text, m.acpMessageId])).toEqual([
      ['one more', 'm1'],
      ['two', 'm2']
    ])
  })

  it('cancels a running turn with session/cancel', async () => {
    state.script = async ({ say, cancelled }) => {
      await say('Working')
      await cancelled
      return 'cancelled'
    }
    const session = await manager.createSession('/w', 'fake')
    const turn = manager.send(session.id, 'long task', null)
    await vi.waitFor(() => expect(manager.openSession(session.id).messages).toHaveLength(2))
    expect(manager.openSession(session.id).turn).toEqual({ threadId: null })
    await expect(manager.send(session.id, 'again', null)).rejects.toThrow(/already running/)

    await manager.cancel(session.id)
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect(manager.openSession(session.id).turn).toBeNull()
  })

  it('defers an agent restart until the running turn ends', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    state.script = async ({ say }) => {
      await gate
      await say('done')
      return 'end_turn'
    }
    const session = await manager.createSession('/w', 'fake')
    const turn = manager.send(session.id, 'slow', null)
    await vi.waitFor(() => expect(state.prompts).toEqual(['slow']))

    await manager.restartAgents()
    release()
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    expect(manager.openSession(session.id).messages.at(-1)?.text).toBe('done')

    state.script = async ({ say }) => {
      await say('ok')
      return 'end_turn'
    }
    await manager.send(session.id, 'next', null)
    expect(state.connections).toBe(2)
    expect(state.loads).toEqual([session.acpSessionId])
  })

  it('resumes with session/load after a restart and ignores the replay', async () => {
    const session = await manager.createSession('/w', 'fake')
    await manager.send(session.id, 'first', null)
    await manager.dispose()

    // A new app run: same DB and agent state, fresh process.
    manager = makeManager()
    await manager.send(session.id, 'second', null)

    expect(state.loads).toEqual([session.acpSessionId])
    const view = manager.openSession(session.id)
    expect(view.session.acpSessionId).toBe(session.acpSessionId)
    expect(view.messages.map((m) => m.text)).toEqual(['first', 'Hello world', 'second', 'Hello world'])
    expect(events.some((e) => e.type === 'notice')).toBe(false)
  })

  it('starts a new agent session with a notice when the agent cannot load', async () => {
    state.loadSession = false
    const session = await manager.createSession('/w', 'fake')
    await manager.send(session.id, 'first', null)
    await manager.dispose()

    manager = makeManager()
    await manager.send(session.id, 'second', null)

    const view = manager.openSession(session.id)
    expect(state.loads).toEqual([])
    expect(view.session.acpSessionId).not.toBe(session.acpSessionId)
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', sessionId: session.id }))
    expect(view.messages.map((m) => m.text)).toEqual(['first', 'Hello world', 'second', 'Hello world'])
  })

  it('signs in with an agent method on auth_required and retries the prompt', async () => {
    state.authMethods = [{ id: 'oauth', name: 'Log in', description: 'Use your account' }]
    const session = await manager.createSession('/w', 'fake')
    state.signedIn = false

    const turn = manager.send(session.id, 'hi', null)
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'authRequired',
        agentId: 'fake',
        agentName: 'Fake Agent',
        methods: [{ id: 'oauth', name: 'Log in', description: 'Use your account', kind: 'agent' }]
      })
    )
    await expect(manager.signIn('fake', 'oauth')).resolves.toEqual({ ok: true })
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })

    expect(state.authenticated).toEqual(['oauth'])
    expect(runInTerminal).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: 'authResolved', agentId: 'fake' })
    // The user's message is stored once even though the prompt was sent twice.
    expect(manager.openSession(session.id).messages.map((m) => m.text)).toEqual(['hi', 'Hello world'])
  })

  it('runs terminal sign-in methods with the agent command, then restarts the agent', async () => {
    state.authMethods = [
      { id: 'login', name: 'Terminal login', type: 'terminal', args: ['auth', 'login'], env: { MODE: 'x' } }
    ]
    runInTerminal.mockImplementation(async () => {
      state.signedIn = true
      return 0
    })
    const session = await manager.createSession('/w', 'fake')
    state.signedIn = false

    const turn = manager.send(session.id, 'hi', null)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'authRequired')).toBe(true))
    await expect(manager.signIn('fake', 'login')).resolves.toEqual({ ok: true })
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })

    expect(runInTerminal).toHaveBeenCalledWith('fake-agent', ['--acp', 'auth', 'login'], {
      FAKE: '1',
      MODE: 'x'
    })
    expect(state.connections).toBe(2)
    expect(state.loads).toEqual([session.acpSessionId])
  })

  it('ends the turn with an error when sign-in is dismissed', async () => {
    state.authMethods = [{ id: 'oauth', name: 'Log in' }]
    const session = await manager.createSession('/w', 'fake')
    state.signedIn = false
    const turn = manager.send(session.id, 'hi', null)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'authRequired')).toBe(true))
    manager.dismissSignIn('fake')
    await expect(turn).resolves.toEqual({ error: 'Sign-in was cancelled.' })
  })

  it('reports auth_required as an error when the agent offers no sign-in methods', async () => {
    const session = await manager.createSession('/w', 'fake')
    state.signedIn = false
    const result = await manager.send(session.id, 'hi', null)
    expect(result.error).toMatch(/Authentication required/)
    expect(events.some((e) => e.type === 'authRequired')).toBe(false)
  })
})
