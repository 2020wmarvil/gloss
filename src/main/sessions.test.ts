import { pathToFileURL } from 'node:url'
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
  requestPermission(title: string, options?: acp.PermissionOption[]): Promise<acp.RequestPermissionResponse>
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
  /** Session modes reported by session/new and session/load; null = the agent has none. */
  modes: acp.SessionModeState | null
  /** session/set_mode calls, as "sessionId:modeId". */
  modeChanges: string[]
  /** session/set_mode fails. */
  refuseModes: boolean
  /** History replayed by session/load, per session; default: one agent chunk "REPLAY". */
  history: Map<string, acp.SessionUpdate[]>
  /** Advertise session/list and session/delete. */
  canList: boolean
  canDelete: boolean
  /** Sessions returned by session/list (filtered by cwd). */
  listed: acp.SessionInfo[]
  deleted: string[]
  /** session/delete fails. */
  refuseDelete: boolean
  /** Config options reported by session/new and session/load. */
  configOptions: acp.SessionConfigOption[] | null
  /** session/set_config_option calls, as "sessionId:configId=value". */
  configChanges: string[]
  promptCapabilities: acp.PromptCapabilities
  /** The full prompt of each session/prompt. */
  promptBlocks: acp.ContentBlock[][]
  /** Slash commands announced after session/new and session/load. */
  commands: acp.AvailableCommand[]
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
    modes: null,
    modeChanges: [],
    refuseModes: false,
    history: new Map(),
    canList: false,
    canDelete: false,
    listed: [],
    deleted: [],
    refuseDelete: false,
    configOptions: null,
    configChanges: [],
    promptCapabilities: {},
    promptBlocks: [],
    commands: [],
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
      agentCapabilities: {
        loadSession: state.loadSession,
        promptCapabilities: state.promptCapabilities,
        sessionCapabilities: {
          ...(state.canList ? { list: {} } : {}),
          ...(state.canDelete ? { delete: {} } : {})
        }
      },
      authMethods: state.authMethods
    }))
    .onRequest(acp.methods.agent.session.list, (ctx) => ({
      sessions: state.listed.filter((s) => s.cwd === ctx.params.cwd)
    }))
    .onRequest(acp.methods.agent.session.delete, (ctx) => {
      if (state.refuseDelete) throw acp.RequestError.internalError()
      state.deleted.push(ctx.params.sessionId)
      state.sessions.delete(ctx.params.sessionId)
      return {}
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
      const value = 'value' in ctx.params ? String(ctx.params.value) : ''
      state.configChanges.push(`${ctx.params.sessionId}:${ctx.params.configId}=${value}`)
      state.configOptions = (state.configOptions ?? []).map((o) =>
        o.id === ctx.params.configId && o.type === 'select' ? { ...o, currentValue: value } : o
      )
      return { configOptions: state.configOptions }
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      state.authenticated.push(ctx.params.methodId)
      state.signedIn = true
      return {}
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sessionId = `acp-${state.connections}-${next++}`
      state.sessions.add(sessionId)
      if (state.commands.length > 0) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'available_commands_update', availableCommands: state.commands }
        })
      }
      return { sessionId, modes: state.modes, configOptions: state.configOptions }
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      if (state.refuseModes) throw acp.RequestError.internalError(undefined, 'mode refused')
      state.modeChanges.push(`${ctx.params.sessionId}:${ctx.params.modeId}`)
      return {}
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const { sessionId } = ctx.params
      state.loads.push(sessionId)
      if (!state.sessions.has(sessionId)) throw acp.RequestError.resourceNotFound(sessionId)
      // Replay history, as the Claude adapter does.
      const history = state.history.get(sessionId) ?? [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } }
      ]
      for (const update of history) {
        await ctx.client.notify(acp.methods.client.session.update, { sessionId, update })
      }
      return { modes: state.modes, configOptions: state.configOptions }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      cancels.get(ctx.params.sessionId)?.()
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      if (!state.signedIn) throw acp.RequestError.authRequired()
      const { sessionId } = ctx.params
      const block = ctx.params.prompt[0]
      const text = block?.type === 'text' ? block.text : ''
      state.prompts.push(text)
      state.promptBlocks.push(ctx.params.prompt)
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
        requestPermission: (title, options) =>
          ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: 'perm', title },
            options: options ?? [
              { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
            ]
          }),
        cancelled
      })
      return { stopReason }
    })
}

const config: AgentConfig = {
  id: 'fake',
  name: 'Fake Agent',
  command: 'fake-agent',
  args: ['--acp'],
  bypassModeId: 'bypass'
}

const MODES: acp.SessionModeState = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'bypass', name: 'Bypass permissions' }
  ]
}

describe('SessionManager', () => {
  let store: Store
  let events: GlossEvent[]
  let state: FakeAgent
  let manager: SessionManager
  let runInTerminal: ReturnType<typeof vi.fn>
  let devModel: boolean

  function makeManager(): SessionManager {
    return new SessionManager({
      store,
      emit: (e) => events.push(e),
      getAgentConfig: () => config,
      agentEnv: () => ({ FAKE: '1' }),
      connect: (_config, _env, handlers) => AgentConnection.open(agentApp(state), handlers),
      runInTerminal: runInTerminal as never,
      devModel: () => devModel,
      now: () => 1000
    })
  }

  beforeEach(() => {
    store = new Store(':memory:')
    events = []
    devModel = false
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
    expect(events.at(-1)).toEqual({
      type: 'turnEnd',
      sessionId: session.id,
      threadId: null,
      stopReason: 'end_turn'
    })
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

  describe('threads', () => {
    const REVIEW = '1. **Cache invalidation races the write path**\n2. **N+1 query** in GET /orders\n'

    async function reviewed(): Promise<{ sessionId: string; reviewId: string }> {
      state.script = async ({ say }) => {
        await say(REVIEW)
        return 'end_turn'
      }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'Review it', null)
      const review = manager.openSession(session.id).messages.find((m) => m.role === 'agent')!
      return { sessionId: session.id, reviewId: review.id }
    }

    it('tags thread messages on the wire and routes the reply into the thread', async () => {
      const { sessionId, reviewId } = await reviewed()
      const thread = manager.createThread(sessionId, reviewId, {
        kind: 'listItem',
        path: [1],
        text: 'N+1 query in GET /orders'
      })
      expect(events).toContainEqual({ type: 'thread', thread })

      state.script = async ({ say, update }) => {
        await say('It is hot on the dashboard.')
        await update({ sessionUpdate: 'tool_call', toolCallId: 'q', title: 'Grep orders', status: 'completed' })
        await say('Batch it.')
        return 'end_turn'
      }
      await expect(manager.send(sessionId, 'Is this hot?', thread.id)).resolves.toEqual({ stopReason: 'end_turn' })

      expect(state.prompts.at(-1)).toBe('[re: "N+1 query in GET /orders"]\nIs this hot?')
      expect(events).toContainEqual({ type: 'turnStart', sessionId, threadId: thread.id })
      expect(events.at(-1)).toMatchObject({ type: 'turnEnd', threadId: thread.id })

      const view = manager.openSession(sessionId)
      expect(view.threads).toEqual([thread])
      const inThread = view.messages.filter((m) => m.threadId === thread.id)
      expect(inThread.map((m) => [m.role, m.text])).toEqual([
        ['user', 'Is this hot?'],
        ['agent', 'It is hot on the dashboard.'],
        ['agent', 'Batch it.']
      ])
      expect(inThread[0].wireText).toBe('[re: "N+1 query in GET /orders"]\nIs this hot?')
      expect(view.toolCalls.map((t) => [t.id, t.threadId])).toEqual([['q', thread.id]])
      // The main thread is unchanged.
      expect(view.messages.filter((m) => m.threadId === null)).toHaveLength(2)

      // Back in the main thread, messages are sent untagged.
      await manager.send(sessionId, 'ok, do 1 and 2', null)
      expect(state.prompts.at(-1)).toBe('ok, do 1 and 2')
    })

    it('truncates long anchors in the wire tag', async () => {
      const { sessionId, reviewId } = await reviewed()
      const long = 'word '.repeat(40)
      const thread = manager.createThread(sessionId, reviewId, { kind: 'listItem', path: [0], text: long })
      await manager.send(sessionId, 'why?', thread.id)
      const tag = state.prompts.at(-1)!.split('\n')[0]
      expect(tag).toMatch(/^\[re: "(word ){15}word…"\]$/)
      expect(tag.length).toBeLessThanOrEqual('[re: ""]'.length + 80)
    })

    it('returns the existing thread for the same anchor', async () => {
      const { sessionId, reviewId } = await reviewed()
      const anchor = { kind: 'listItem' as const, path: [0], text: 'Cache invalidation' }
      const a = manager.createThread(sessionId, reviewId, anchor)
      const b = manager.createThread(sessionId, reviewId, anchor)
      const c = manager.createThread(sessionId, reviewId, { ...anchor, path: [1] })
      expect(b).toEqual(a)
      expect(c.id).not.toBe(a.id)
      expect(manager.openSession(sessionId).threads).toHaveLength(2)
    })

    it('anchors threads to selections by source offsets', async () => {
      const { sessionId, reviewId } = await reviewed()
      const start = REVIEW.indexOf('races')
      const anchor = { kind: 'selection' as const, start, end: start + 'races the write'.length, text: 'races the write' }
      const thread = manager.createThread(sessionId, reviewId, anchor)
      expect(thread.anchor).toEqual(anchor)
      expect(manager.createThread(sessionId, reviewId, anchor).id).toBe(thread.id)
      expect(manager.createThread(sessionId, reviewId, { ...anchor, end: anchor.end + 1 }).id).not.toBe(thread.id)
      expect(() => manager.createThread(sessionId, reviewId, { ...anchor, end: start })).toThrow(/Invalid/)

      await manager.send(sessionId, 'why?', thread.id)
      expect(state.prompts.at(-1)).toBe('[re: "races the write"]\nwhy?')
    })

    it('only anchors threads to agent messages in the same session', async () => {
      const { sessionId, reviewId } = await reviewed()
      const userMessage = manager.openSession(sessionId).messages.find((m) => m.role === 'user')!
      const anchor = { kind: 'listItem' as const, path: [0], text: 'x' }
      expect(() => manager.createThread(sessionId, userMessage.id, anchor)).toThrow(/agent message/)
      const other = await manager.createSession('/other', 'fake')
      expect(() => manager.createThread(other.id, reviewId, anchor)).toThrow(/agent message/)
      expect(() => manager.createThread(sessionId, reviewId, { ...anchor, text: ' ' })).toThrow(/Invalid/)
      await expect(manager.send(sessionId, 'hi', 'no-such-thread')).rejects.toThrow(/Unknown thread/)
    })

    it('shows notices in the thread whose turn produced them', async () => {
      state.loadSession = false
      const { sessionId, reviewId } = await reviewed()
      const thread = manager.createThread(sessionId, reviewId, { kind: 'listItem', path: [0], text: 'Cache' })
      await manager.dispose()
      manager = makeManager()
      // The agent cannot resume, so the "lost context" notice comes from this thread's turn.
      await manager.send(sessionId, 'fix it', thread.id)
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'notice', sessionId, threadId: thread.id })
      )
    })
  })

  describe('permissions', () => {
    it('switches new and resumed sessions to the bypass mode', async () => {
      state.modes = MODES
      const session = await manager.createSession('/w', 'fake')
      expect(state.modeChanges).toEqual([`${session.acpSessionId}:bypass`])

      await manager.dispose()
      manager = makeManager()
      await manager.send(session.id, 'hi', null)
      expect(state.modeChanges).toEqual([`${session.acpSessionId}:bypass`, `${session.acpSessionId}:bypass`])
    })

    it('leaves the mode alone when it is already set or not offered', async () => {
      state.modes = { ...MODES, currentModeId: 'bypass' }
      await manager.createSession('/a', 'fake')
      state.modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] }
      await manager.createSession('/b', 'fake')
      state.modes = null
      await manager.createSession('/c', 'fake')
      expect(state.modeChanges).toEqual([])
    })

    it('still works when the agent refuses the bypass mode', async () => {
      state.modes = MODES
      state.refuseModes = true
      const session = await manager.createSession('/w', 'fake')
      await expect(manager.send(session.id, 'hi', null)).resolves.toEqual({ stopReason: 'end_turn' })
    })

    it('approves permission requests, preferring allow once', async () => {
      const outcomes: acp.RequestPermissionResponse[] = []
      state.script = async ({ requestPermission }) => {
        outcomes.push(await requestPermission('Edit orders.ts'))
        outcomes.push(
          await requestPermission('Run tests', [
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            { optionId: 'always', name: 'Always', kind: 'allow_always' }
          ])
        )
        outcomes.push(await requestPermission('Odd', [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]))
        return 'end_turn'
      }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'fix it', null)
      expect(outcomes).toEqual([
        { outcome: { outcome: 'selected', optionId: 'allow' } },
        { outcome: { outcome: 'selected', optionId: 'always' } },
        { outcome: { outcome: 'cancelled' } }
      ])
      expect(events.some((e) => e.type === 'notice')).toBe(false)
    })

    it('reports bypass or auto-approval in the live state', async () => {
      state.modes = MODES
      const a = await manager.createSession('/w', 'fake')
      expect(manager.openSession(a.id).live.permissions).toBe('bypass')
      state.refuseModes = true
      const b = await manager.createSession('/w', 'fake')
      expect(manager.openSession(b.id).live.permissions).toBe('auto')
    })
  })

  describe('session management', () => {
    it('renames a session', async () => {
      const session = await manager.createSession('/w', 'fake')
      expect(manager.renameSession(session.id, '  Order   review ').title).toBe('Order review')
      expect(store.getSession(session.id)?.title).toBe('Order review')
      expect(() => manager.renameSession(session.id, '   ')).toThrow()
    })

    it('deletes a session from the DB and the agent', async () => {
      state.canDelete = true
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'hi', null)
      const message = manager.openSession(session.id).messages[1]
      manager.createThread(session.id, message.id, { kind: 'selection', start: 0, end: 5, text: 'Hello' })

      await expect(manager.deleteSession(session.id)).resolves.toBeNull()
      expect(state.deleted).toEqual([session.acpSessionId])
      expect(store.getSession(session.id)).toBeUndefined()
      expect(store.listMessages(session.id)).toEqual([])
      expect(store.listToolCalls(session.id)).toEqual([])
      expect(store.listThreads(session.id)).toEqual([])
      expect(events.at(-1)).toEqual({ type: 'sessionDeleted', sessionId: session.id })
    })

    it("warns when the agent can't delete its copy, unless the session never had a message", async () => {
      state.canDelete = true
      state.refuseDelete = true
      const empty = await manager.createSession('/w', 'fake')
      await expect(manager.deleteSession(empty.id)).resolves.toBeNull()
      const used = await manager.createSession('/w', 'fake')
      await manager.send(used.id, 'hi', null)
      await expect(manager.deleteSession(used.id)).resolves.toMatch(/couldn't delete its own copy/)
      expect(manager.listSessions()).toEqual([])
    })

    it('deletes only from Gloss when the agent cannot delete sessions', async () => {
      const session = await manager.createSession('/w', 'fake')
      await expect(manager.deleteSession(session.id)).resolves.toBeNull()
      expect(state.deleted).toEqual([])
      expect(store.getSession(session.id)).toBeUndefined()
    })

    it('cancels a running turn before deleting', async () => {
      state.canDelete = true
      state.script = async ({ say, cancelled }) => {
        await say('Working')
        await cancelled
        return 'cancelled'
      }
      const session = await manager.createSession('/w', 'fake')
      const turn = manager.send(session.id, 'long', null)
      await vi.waitFor(() => expect(store.listMessages(session.id)).toHaveLength(2))
      await manager.deleteSession(session.id)
      await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
      expect(store.getSession(session.id)).toBeUndefined()
    })
  })

  describe('projects and existing sessions', () => {
    it('lists folders of sessions and opened projects, most recent first, without duplicates', async () => {
      let now = 1
      manager = new SessionManager({
        store,
        emit: (e) => events.push(e),
        getAgentConfig: () => config,
        agentEnv: () => ({}),
        connect: (_c, _e, handlers) => AgentConnection.open(agentApp(state), handlers),
        runInTerminal: runInTerminal as never,
        now: () => now++
      })
      await manager.createSession('/work/shop', 'fake')
      manager.addProject('/work/blog')
      await manager.createSession('/work/shop', 'fake')
      expect(manager.listProjects()).toEqual([
        { path: '/work/shop', name: 'shop' },
        { path: '/work/blog', name: 'blog' }
      ])
    })

    it("lists the agent's sessions for a folder that Gloss hasn't imported", async () => {
      state.canList = true
      const mine = await manager.createSession('/w', 'fake')
      state.listed = [
        { sessionId: mine.acpSessionId, cwd: '/w', title: 'mine' },
        { sessionId: 'cli-1', cwd: '/w', title: 'Old CLI work', updatedAt: '2026-10-01T00:00:00Z' },
        { sessionId: 'cli-2', cwd: '/w', updatedAt: '2026-10-05T00:00:00Z' },
        { sessionId: 'cli-3', cwd: '/elsewhere', title: 'other folder' }
      ]
      expect(await manager.agentSessions('/w', 'fake')).toEqual([
        { acpSessionId: 'cli-2', title: 'Untitled session', updatedAt: '2026-10-05T00:00:00Z' },
        { acpSessionId: 'cli-1', title: 'Old CLI work', updatedAt: '2026-10-01T00:00:00Z' }
      ])
    })

    it('deletes a project with its sessions and their agent copies, leaving other projects', async () => {
      state.canDelete = true
      const a = await manager.createSession('/work/shop', 'fake')
      const b = await manager.createSession('/work/shop', 'fake')
      const other = await manager.createSession('/work/blog', 'fake')
      manager.addProject('/work/shop')

      await expect(manager.deleteProject('/work/shop')).resolves.toBeNull()
      expect(state.deleted.sort()).toEqual([a.acpSessionId, b.acpSessionId].sort())
      expect(manager.listSessions().map((s) => s.id)).toEqual([other.id])
      expect(manager.listProjects()).toEqual([{ path: '/work/blog', name: 'blog' }])
    })

    it('lists nothing when the agent cannot list sessions', async () => {
      expect(await manager.agentSessions('/w', 'fake')).toEqual([])
    })

    it('imports a session, building its main thread from the session/load replay', async () => {
      state.sessions.add('cli-1')
      state.history.set('cli-1', [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fix the ' }, messageId: 'u1' },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'build' }, messageId: 'u1' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' }, messageId: 'a1' },
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm run build', kind: 'execute', status: 'pending' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed.' }, messageId: 'a2' },
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
          messageId: 'u2'
        },
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'And this?' }, messageId: 'u2' }
      ])
      const session = await manager.importSession('/w', 'fake', 'cli-1', 'Old CLI work')
      expect(session).toMatchObject({ acpSessionId: 'cli-1', cwd: '/w', title: 'Old CLI work' })

      const view = manager.openSession(session.id)
      expect(view.messages.map((m) => [m.seq, m.role, m.text, m.threadId])).toEqual([
        [0, 'user', 'Fix the build', null],
        [1, 'agent', 'Looking.', null],
        [3, 'agent', 'Fixed.', null],
        [4, 'user', 'And this?', null]
      ])
      expect(view.messages[3].attachments).toEqual([
        { kind: 'image', name: 'image', mimeType: 'image/png', data: 'iVBOR' }
      ])
      expect(view.toolCalls.map((t) => [t.messageSeq, t.title, t.status])).toEqual([[2, 'npm run build', 'completed']])
      expect(manager.listProjects()).toEqual([{ path: '/w', name: 'w' }])

      // Importing it again returns the same session; a later turn continues it without re-recording the replay.
      expect((await manager.importSession('/w', 'fake', 'cli-1', 'x')).id).toBe(session.id)
      await manager.send(session.id, 'next', null)
      expect(manager.openSession(session.id).messages.map((m) => m.text).slice(-2)).toEqual(['next', 'Hello world'])
    })

    it('removes a failed import', async () => {
      await expect(manager.importSession('/w', 'fake', 'missing', 'Gone')).rejects.toThrow()
      expect(manager.listSessions()).toEqual([])
    })
  })

  describe('live session state', () => {
    const MODEL: acp.SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default', description: 'Sonnet' },
        { value: 'opus', name: 'Opus' }
      ]
    }

    it('reports the model option, commands, usage and what prompts accept', async () => {
      state.configOptions = [MODEL]
      state.commands = [{ name: 'compact', description: 'Compact the context', input: { hint: '[focus]' } }]
      state.promptCapabilities = { image: true, embeddedContext: true }
      state.script = async ({ update }) => {
        await update({ sessionUpdate: 'usage_update', used: 50_000, size: 200_000, cost: { amount: 0.12, currency: 'USD' } })
        return 'end_turn'
      }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'hi', null)
      expect(manager.openSession(session.id).live).toEqual({
        attached: true,
        model: {
          configId: 'model',
          current: 'default',
          options: [
            { value: 'default', name: 'Default', description: 'Sonnet' },
            { value: 'opus', name: 'Opus' }
          ]
        },
        commands: [{ name: 'compact', description: 'Compact the context', hint: '[focus]' }],
        usage: { used: 50_000, size: 200_000, cost: { amount: 0.12, currency: 'USD' } },
        rateLimits: [],
        permissions: 'auto',
        accepts: { image: true, file: true }
      })
      expect(events).toContainEqual(expect.objectContaining({ type: 'live', sessionId: session.id }))
    })

    it("tracks Claude Code's plan limits per window from usage updates", async () => {
      const usage = (info: Record<string, unknown>): acp.SessionUpdate => ({
        sessionUpdate: 'usage_update',
        used: 1000,
        size: 200_000,
        _meta: { '_claude/rateLimit': info }
      })
      state.script = async ({ update }) => {
        await update(usage({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1_791_873_000 }))
        await update(usage({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.82 }))
        await update(usage({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_791_873_000, utilization: 100 }))
        // Usage updates without rate-limit info keep what is known.
        await update({ sessionUpdate: 'usage_update', used: 2000, size: 200_000 })
        return 'end_turn'
      }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'hi', null)
      expect(manager.openSession(session.id).live.rateLimits).toEqual([
        { window: 'seven_day', status: 'warning', utilization: 82 },
        { window: 'five_hour', status: 'rejected', utilization: 100, resetsAt: 1_791_873_000_000 }
      ])
    })

    it('resumes a session on the agent when it is opened', async () => {
      state.configOptions = [MODEL]
      const session = await manager.createSession('/w', 'fake')
      await manager.dispose()
      manager = makeManager()
      expect(manager.openSession(session.id).live.attached).toBe(false)
      await vi.waitFor(() => expect(manager.openSession(session.id).live.attached).toBe(true))
      expect(state.loads).toEqual([session.acpSessionId])
      expect(manager.openSession(session.id).live.model?.current).toBe('default')
    })

    it('sets the model per session and re-applies it on resume', async () => {
      state.configOptions = [MODEL]
      const session = await manager.createSession('/w', 'fake')
      await manager.setModel(session.id, 'opus')
      expect(manager.openSession(session.id).live.model?.current).toBe('opus')
      expect(store.getSession(session.id)?.model).toBe('opus')

      // The agent forgets it (a fresh process); Gloss sets it again when resuming.
      state.configOptions = [MODEL]
      await manager.dispose()
      manager = makeManager()
      await manager.send(session.id, 'hi', null)
      expect(state.configChanges).toEqual([`${session.acpSessionId}:model=opus`, `${session.acpSessionId}:model=opus`])
    })

    it('leaves the model alone while the dev model is on', async () => {
      state.configOptions = [MODEL]
      const session = await manager.createSession('/w', 'fake')
      await manager.setModel(session.id, 'opus')
      devModel = true
      await expect(manager.setModel(session.id, 'default')).rejects.toThrow(/dev model/)
      await manager.dispose()
      manager = makeManager()
      await manager.send(session.id, 'hi', null)
      expect(state.configChanges).toEqual([`${session.acpSessionId}:model=opus`])
    })
  })

  describe('attachments', () => {
    it('sends images and files after the text and stores them on the message', async () => {
      state.promptCapabilities = { image: true, embeddedContext: true }
      const session = await manager.createSession('/w', 'fake')
      const attachments = [
        { kind: 'image' as const, name: 'shot.png', mimeType: 'image/png', data: 'iVBOR' },
        { kind: 'file' as const, name: 'notes.md', path: '/w/notes.md', mimeType: 'text/markdown', text: '# Notes' }
      ]
      await manager.send(session.id, 'look', null, attachments)
      expect(state.promptBlocks.at(-1)).toEqual([
        { type: 'text', text: 'look' },
        { type: 'image', data: 'iVBOR', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: pathToFileURL('/w/notes.md').href, text: '# Notes', mimeType: 'text/markdown' } }
      ])
      expect(manager.openSession(session.id).messages[0].attachments).toEqual(attachments)
    })

    it('fails the turn when the agent does not accept an attachment', async () => {
      const session = await manager.createSession('/w', 'fake')
      const result = await manager.send(session.id, 'look', null, [
        { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'x' }
      ])
      expect(result.error).toMatch(/images/)
      expect(state.prompts).toEqual([])
    })
  })
})
