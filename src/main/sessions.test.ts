import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import type { GlossEvent, PullRequest } from '../shared/ipc'
import { AgentConnection } from './acp'
import type { AgentConfig } from './agents'
import { Store } from './db'
import { SessionManager } from './sessions'
import { threadTag, toMainTag, wireTag } from '../shared/wire'
import { isFirstPass, REVIEW_INSTRUCTIONS, type ReviewDiff } from '../shared/review'
import type { Session } from '../shared/types'

type Script = (ctx: {
  sessionId: string
  text: string
  say(text: string, messageId?: string): Promise<void>
  update(update: acp.SessionUpdate): Promise<void>
  requestPermission(title: string, options?: acp.PermissionOption[]): Promise<acp.RequestPermissionResponse>
  cancelled: Promise<void>
  /** Resolves with the text of the next message steered into this turn. */
  nextSteer(): Promise<string>
}) => Promise<acp.StopReason>

/** State shared by every connection to the fake agent, like a real agent's disk state. */
type FakeAgent = {
  loadSession: boolean
  authMethods: acp.AuthMethod[]
  signedIn: boolean
  sessions: Set<string>
  prompts: string[]
  loads: string[]
  /** The `_meta` of each session/new and session/load, in order. */
  metas: { method: 'new' | 'load'; meta: unknown }[]
  mcpCapabilities: acp.McpCapabilities
  mcpRequests: { method: 'new' | 'load'; servers: acp.McpServer[] }[]
  authenticated: string[]
  connections: number
  /** Session modes reported by session/new and session/load; null = the agent has none. */
  modes: acp.SessionModeState | null
  /** session/set_mode calls, as "sessionId:modeId". */
  modeChanges: string[]
  /** session/set_mode fails. */
  refuseModes: boolean
  /**
   * Each session's saved history, like Claude Code's transcript: prompts, steered
   * messages and what the script sends. session/load replays it.
   */
  transcripts: Map<string, acp.SessionUpdate[]>
  /** History replayed by session/load instead of the transcript, per session. */
  history: Map<string, acp.SessionUpdate[]>
  /** Each session's last change (session/list `updatedAt`), from a clock that ticks on every change. */
  updatedAt: Map<string, string>
  clock: number
  /** Each session's folder, for session/list. */
  cwds: Map<string, string>
  /** session/load fails with an internal error. */
  failLoad: boolean
  /** session/load fails as Codex's does while another Codex client holds the session. */
  loadInUse: boolean
  /** Advertise session/list, session/delete and session/close. */
  canList: boolean
  canDelete: boolean
  canClose: boolean
  closes: string[]
  /** Sessions returned by session/list (filtered by cwd), besides those with a transcript. */
  listed: acp.SessionInfo[]
  deleted: string[]
  /** session/delete fails. */
  refuseDelete: boolean
  /** Config options reported by session/new and session/load. */
  configOptions: acp.SessionConfigOption[] | null
  /** session/set_config_option calls, as "sessionId:configId=value". */
  configChanges: string[]
  /** Runs after a config change, like Claude's adapter rebuilding its options on a model switch. */
  afterConfigChange?(configId: string, options: acp.SessionConfigOption[]): acp.SessionConfigOption[]
  promptCapabilities: acp.PromptCapabilities
  /** The full prompt of each session/prompt. */
  promptBlocks: acp.ContentBlock[][]
  /** Slash commands announced after session/new and session/load. */
  commands: acp.AvailableCommand[]
  /** Advertise the Claude adapter's `_session/steering` extension. */
  steering: boolean
  /** The full prompt of each steered message. */
  steers: acp.ContentBlock[][]
  /** Answer every steer with promptRequired, as if the turn had just ended. */
  turnEnding: boolean
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
    metas: [],
    mcpCapabilities: {},
    mcpRequests: [],
    authenticated: [],
    connections: 0,
    modes: null,
    modeChanges: [],
    refuseModes: false,
    transcripts: new Map(),
    history: new Map(),
    updatedAt: new Map(),
    clock: 0,
    cwds: new Map(),
    failLoad: false,
    loadInUse: false,
    canList: false,
    canDelete: false,
    canClose: false,
    closes: [],
    listed: [],
    deleted: [],
    refuseDelete: false,
    configOptions: null,
    configChanges: [],
    promptCapabilities: {},
    promptBlocks: [],
    commands: [],
    steering: false,
    steers: [],
    turnEnding: false,
    script: async ({ say }) => {
      await say('Hello')
      await say(' world')
      return 'end_turn'
    },
    ...overrides
  }
}

/** Records a change to a session's saved history, as the agent would. */
function touch(state: FakeAgent, sessionId: string): void {
  state.clock++
  state.updatedAt.set(sessionId, new Date(Date.UTC(2026, 9, 1) + state.clock * 1000).toISOString())
}

function save(state: FakeAgent, sessionId: string, ...updates: acp.SessionUpdate[]): void {
  state.transcripts.set(sessionId, [...(state.transcripts.get(sessionId) ?? []), ...updates])
  touch(state, sessionId)
}

/** A prompt as the Claude adapter saves it: text, then each file as a link and its context, images as they are. */
function userChunks(prompt: acp.ContentBlock[], messageId: string): acp.SessionUpdate[] {
  return prompt.flatMap((b): acp.SessionUpdate[] => {
    const chunk = (content: acp.ContentBlock): acp.SessionUpdate => ({ sessionUpdate: 'user_message_chunk', content, messageId })
    if (b.type === 'resource' && 'text' in b.resource) {
      const { uri, text } = b.resource
      const name = decodeURIComponent(uri.split('/').pop() ?? uri)
      return [
        chunk({ type: 'text', text: `[@${name}](${uri})` }),
        chunk({ type: 'text', text: `\n<context ref="${uri}">\n${text}\n</context>` })
      ]
    }
    return [chunk(b)]
  })
}

function agentApp(state: FakeAgent): acp.AgentApp {
  state.connections++
  let userMessages = 0
  const cancels = new Map<string, () => void>()
  /** Running turns' steer listeners, by session. */
  const steerTo = new Map<string, (text: string) => void>()
  let next = 0
  return acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: state.loadSession,
        promptCapabilities: state.promptCapabilities,
        mcpCapabilities: state.mcpCapabilities,
        sessionCapabilities: {
          ...(state.canList ? { list: {} } : {}),
          ...(state.canDelete ? { delete: {} } : {}),
          ...(state.canClose ? { close: {} } : {})
        }
      },
      authMethods: state.authMethods,
      ...(state.steering ? { _meta: { steering: { supported: true } } } : {})
    }))
    .onRequest('_session/steering', { parse: (p) => p as { sessionId: string; prompt: acp.ContentBlock[] } }, (ctx) => {
      const { sessionId, prompt } = ctx.params
      const deliver = steerTo.get(sessionId)
      if (!deliver || state.turnEnding) return { outcome: 'promptRequired', reason: 'noRunningTurn' }
      state.steers.push(prompt)
      save(state, sessionId, ...userChunks(prompt, `u-${state.connections}-${userMessages++}`))
      deliver(prompt[0]?.type === 'text' ? prompt[0].text : '')
      return { outcome: 'injected' }
    })
    .onRequest(acp.methods.agent.session.list, (ctx) => {
      const saved = [...state.transcripts.keys()]
        .filter((id) => state.sessions.has(id) && !state.listed.some((s) => s.sessionId === id))
        .map((id): acp.SessionInfo => ({ sessionId: id, cwd: state.cwds.get(id) ?? '', updatedAt: state.updatedAt.get(id) }))
      return { sessions: [...state.listed, ...saved].filter((s) => s.cwd === ctx.params.cwd) }
    })
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      state.closes.push(ctx.params.sessionId)
      return {}
    })
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
      if (state.afterConfigChange) state.configOptions = state.afterConfigChange(ctx.params.configId, state.configOptions)
      return { configOptions: state.configOptions }
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      state.authenticated.push(ctx.params.methodId)
      state.signedIn = true
      return {}
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sessionId = `acp-${state.connections}-${next++}`
      state.metas.push({ method: 'new', meta: ctx.params._meta })
      state.mcpRequests.push({ method: 'new', servers: ctx.params.mcpServers })
      state.sessions.add(sessionId)
      state.cwds.set(sessionId, ctx.params.cwd)
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
      state.metas.push({ method: 'load', meta: ctx.params._meta })
      state.mcpRequests.push({ method: 'load', servers: ctx.params.mcpServers })
      if (state.failLoad) throw acp.RequestError.internalError(undefined, 'transcript unreadable')
      if (state.loadInUse) {
        throw acp.RequestError.invalidRequest(
          { reason: 'thread_active_writer', threadId: sessionId },
          'This Codex session is in use by another Codex client.'
        )
      }
      if (!state.sessions.has(sessionId)) throw acp.RequestError.resourceNotFound(sessionId)
      // Replay history, as the Claude adapter does.
      const history = state.history.get(sessionId) ?? state.transcripts.get(sessionId) ?? []
      for (const update of history) {
        await ctx.client.notify(acp.methods.client.session.update, { sessionId, update })
      }
      // Claude Code writes to the transcript when it resumes a session.
      if (state.transcripts.has(sessionId)) touch(state, sessionId)
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
      save(state, sessionId, ...userChunks(ctx.params.prompt, `u-${state.connections}-${userMessages++}`))
      const update = (u: acp.SessionUpdate): Promise<void> => {
        if (u.sessionUpdate !== 'usage_update' && u.sessionUpdate !== 'available_commands_update') save(state, sessionId, u)
        return ctx.client.notify(acp.methods.client.session.update, { sessionId, update: u })
      }
      const cancelled = new Promise<void>((resolve) => cancels.set(sessionId, resolve))
      const steered: string[] = []
      let waiting: ((text: string) => void) | undefined
      steerTo.set(sessionId, (t) => {
        if (waiting) waiting(t)
        else steered.push(t)
        waiting = undefined
      })
      const nextSteer = (): Promise<string> =>
        steered.length > 0 ? Promise.resolve(steered.shift()!) : new Promise((r) => (waiting = r))
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
        cancelled,
        nextSteer
      }).finally(() => steerTo.delete(sessionId))
      return { stopReason }
    })
}

const config: AgentConfig = {
  id: 'fake',
  name: 'Fake Agent',
  command: 'fake-agent',
  args: ['--acp'],
  bypassModeId: 'bypass',
  sessionMeta: () => ({ new: { instructions: 'new' }, load: { instructions: 'load' } })
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
  let servers: import('../shared/mcp').McpServer[]
  let handoffDir: string

  function makeManager(): SessionManager {
    return new SessionManager({
      store,
      emit: (e) => events.push(e),
      getAgentConfig: () => config,
      agentEnv: () => ({ FAKE: '1' }),
      connect: (_config, _env, handlers) => AgentConnection.open(agentApp(state), handlers),
      runInTerminal: runInTerminal as never,
      now: () => 1000,
      mcpServers: () => servers,
      handoffDir
    })
  }

  beforeEach(() => {
    handoffDir = mkdtempSync(join(tmpdir(), 'gloss-handoff-test-'))
    store = new Store(':memory:')
    events = []
    state = fakeAgent()
    servers = []
    runInTerminal = vi.fn(async () => 0)
    manager = makeManager()
  })

  afterEach(async () => {
    await manager.dispose()
    store.close()
    rmSync(handoffDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it('passes project MCP servers to creation and resume, preserving threads', async () => {
    servers = [{ name: 'tools', command: '/tools/mcp', args: ['--local'], env: [{ name: 'MODE', value: 'test' }] }]
    const session = await manager.createSession('/project', 'claude')
    await manager.send(session.id, 'hello', null)
    const answer = store.listMessages(session.id).find((m) => m.role === 'agent')!
    const thread = manager.createThread(session.id, answer.id, { kind: 'selection', start: 0, end: 5, text: 'Hello' })
    await manager.dispose()
    manager = makeManager()
    await manager.send(session.id, 'again', thread.id)
    expect(state.mcpRequests).toEqual([{ method: 'new', servers }, { method: 'load', servers }])
    expect(store.listThreads(session.id)).toContainEqual(thread)
  })

  it('generates a thread summary, freezes its transcript and preserves provenance after resume and source deletion', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'main request', null)
    const answer = store.listMessages(source.id).find((m) => m.role === 'agent')!
    const thread = manager.createThread(source.id, answer.id, { kind: 'selection', start: 0, end: 5, text: 'Hello' })
    await manager.send(source.id, 'thread request', thread.id)
    const before = store.listMessages(source.id)
    state.script = async ({ say }) => { await say('Use the existing helper. '); await say('Next: run the tests.'); return 'end_turn' }
    const prepared = await manager.prepareHandoff(source.id, thread.id)
    expect(prepared.summaryKind).toBe('agent')
    expect(prepared.summary).toBe('Use the existing helper. Next: run the tests.')
    expect(state.prompts.at(-1)).toContain('Focus only on the thread')
    expect(state.prompts.at(-1)).toContain('Do not call tools')
    const transcript = readFileSync(prepared.transcriptPath, 'utf8')
    expect(transcript).toContain('thread request')
    expect(transcript).not.toContain('## You / Main conversation')
    expect(transcript).not.toContain('Prepare a concise handoff summary')
    expect(store.listMessages(source.id).slice(0, before.length)).toEqual(before)
    const summaryMessages = store.listMessages(source.id).slice(before.length)
    expect(summaryMessages.every((m) => m.threadId === thread.id)).toBe(true)
    expect(summaryMessages.at(-1)?.text).toBe(prepared.summary)
    const destination = await manager.handoff({ preparedId: prepared.id, agentId: 'codex' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turnEnd' && e.sessionId === destination.id)).toBe(true))
    expect(destination.agentId).toBe('codex')
    expect(destination.cwd).toBe(source.cwd)
    expect(destination.handoff).toMatchObject({ sessionId: source.id, threadId: thread.id, agentId: 'claude', quote: 'Hello', transcriptPath: prepared.transcriptPath })
    const seed = store.listMessages(destination.id)[0]
    expect(seed.text).toBe(prepared.prompt)
    expect(seed.text).toContain(prepared.transcriptPath.replaceAll('\\', '\\\\'))
    expect(seed.text).not.toContain('thread request')
    await manager.dispose()
    manager = makeManager()
    await manager.send(destination.id, 'continue', null)
    expect(store.getSession(destination.id)?.handoff).toEqual(destination.handoff)
    await manager.deleteSession(source.id)
    expect(readFileSync(prepared.transcriptPath, 'utf8')).toBe(transcript)
  })

  it('validates preparations and consumes each reviewed handoff only once', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'hello', null)
    await expect(manager.prepareHandoff(source.id, 'gone')).rejects.toThrow(/thread/)
    await expect(manager.prepareHandoff('gone', null)).rejects.toThrow(/Unknown session/)
    const prepared = await manager.prepareHandoff(source.id, null)
    await expect(manager.handoff({ preparedId: prepared.id, agentId: 'claude' })).rejects.toThrow(/different agent/)
    await expect(manager.handoff({ preparedId: 'gone', agentId: 'codex' })).rejects.toThrow(/no longer available/)
    expect(store.listSessions()).toHaveLength(1)
    const destination = await manager.handoff({ preparedId: prepared.id, agentId: 'codex' })
    await expect(manager.handoff({ preparedId: prepared.id, agentId: 'codex' })).rejects.toThrow(/no longer available/)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turnEnd' && e.sessionId === destination.id)).toBe(true))
  })

  it('keeps a failed destination turn available for retry with its transcript intact', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'hello', null)
    const prepared = await manager.prepareHandoff(source.id, null)
    state.script = async () => { throw acp.RequestError.internalError() }
    const destination = await manager.handoff({ preparedId: prepared.id, agentId: 'codex' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turnEnd' && e.sessionId === destination.id && e.error)).toBe(true))
    expect(store.listMessages(destination.id)[0].outcome).toBe('failed')
    expect(existsSync(prepared.transcriptPath)).toBe(true)
    expect(store.getSession(source.id)).toBeDefined()
  })

  it('uses the local blurb without a summary turn when the source already reports exhausted usage', async () => {
    state.script = async ({ say, update }) => {
      await say('Implemented the cache helper; next run its tests.')
      await update({ sessionUpdate: 'usage_update', used: 1000, size: 200000, _meta: { '_claude/rateLimit': { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1791873000 } } })
      return 'end_turn'
    }
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'work', null)
    const prepared = await manager.prepareHandoff(source.id, null)
    expect(prepared).toMatchObject({ summaryKind: 'blurb', fallbackReason: 'usage' })
    expect(prepared.summary).toContain('Implemented the cache helper')
    expect(state.prompts).toHaveLength(1)
    expect(readFileSync(prepared.transcriptPath, 'utf8')).toContain('Implemented the cache helper')
  })

  it('falls back on a usage-limit response but does not mistake summary prose about limits for a failure', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'work', null)
    state.script = async ({ say }) => { await say("You've hit your limit. Try again tomorrow."); return 'end_turn' }
    const fallback = await manager.prepareHandoff(source.id, null)
    expect(fallback).toMatchObject({ summaryKind: 'blurb', fallbackReason: 'usage' })
    expect(fallback.summary).toContain('Hello world')
    expect(fallback.summary).not.toContain("You've hit your limit")
    state.script = async ({ say }) => { await say('Implemented rate limits in the status line. Next: test reset intervals.'); return 'end_turn' }
    const summary = await manager.prepareHandoff(source.id, null)
    expect(summary.summaryKind).toBe('agent')
    expect(summary.fallbackReason).toBeUndefined()
  })

  it('reports unrelated summary failures and cleans up discarded snapshots', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'work', null)
    state.script = async () => { throw acp.RequestError.internalError() }
    await expect(manager.prepareHandoff(source.id, null)).rejects.toThrow(/generate the handoff summary/)
    state.script = async ({ say }) => { await say('Summary'); return 'end_turn' }
    const prepared = await manager.prepareHandoff(source.id, null)
    manager.discardHandoff(prepared.id)
    expect(existsSync(prepared.transcriptPath)).toBe(false)
    await expect(manager.handoff({ preparedId: prepared.id, agentId: 'codex' })).rejects.toThrow(/no longer available/)
  })

  it('falls back on quota request errors and retains a prepared summary after destination creation errors', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'work', null)
    state.script = async () => { throw new acp.RequestError(-32603, 'Insufficient quota: usage limit reached') }
    const prepared = await manager.prepareHandoff(source.id, null)
    expect(prepared).toMatchObject({ summaryKind: 'blurb', fallbackReason: 'usage' })
    servers = [{ type: 'sse', name: 'unsupported', url: 'https://example.com/mcp', headers: [] }]
    await expect(manager.handoff({ preparedId: prepared.id, agentId: 'codex' })).rejects.toThrow(/SSE/)
    expect(existsSync(prepared.transcriptPath)).toBe(true)
    expect(store.listSessions()).toHaveLength(1)
    servers = []
    state.script = async ({ say }) => { await say('continued'); return 'end_turn' }
    const destination = await manager.handoff({ preparedId: prepared.id, agentId: 'codex' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turnEnd' && e.sessionId === destination.id)).toBe(true))
  })

  it('cancels only the source summary turn when preparation is dismissed', async () => {
    const source = await manager.createSession('/project', 'claude')
    await manager.send(source.id, 'work', null)
    state.script = async ({ cancelled }) => { await cancelled; return 'cancelled' }
    const prepared = manager.prepareHandoff(source.id, null)
    const rejected = expect(prepared).rejects.toThrow(/cancelled/)
    await vi.waitFor(() => expect(state.prompts).toHaveLength(2))
    await expect(manager.prepareHandoff(source.id, null)).rejects.toThrow(/finish/)
    await manager.cancelHandoffPreparation(source.id)
    await rejected
    state.script = async ({ say }) => { await say('next'); return 'end_turn' }
    await manager.send(source.id, 'next', null)
    await manager.cancelHandoffPreparation(source.id)
    expect(store.listMessages(source.id).at(-2)?.outcome).toBe('completed')
  })

  it('rejects unsupported MCP transport before creating a session', async () => {
    servers = [{ type: 'sse', name: 'remote', url: 'https://example.com/mcp', headers: [] }]
    await expect(manager.createSession('/project', 'codex')).rejects.toThrow(/does not support SSE/)
    expect(state.mcpRequests).toEqual([])
    expect(store.listSessions()).toEqual([])
    state.mcpCapabilities = { sse: true }
    await manager.restartIdleAgent('codex')
    await manager.createSession('/project', 'codex')
    expect(state.mcpRequests[0].servers).toEqual(servers)
  })

  it('reloads changed MCP settings before the next prompt without replacing the session', async () => {
    state.canClose = true
    const session = await manager.createSession('/project', 'claude')
    await manager.send(session.id, 'first', null)
    servers = [{ name: 'new-tools', command: '/tools/mcp', args: [], env: [] }]
    await manager.send(session.id, 'second', null)
    expect(state.closes).toEqual([session.acpSessionId])
    expect(state.mcpRequests.at(-1)).toEqual({ method: 'load', servers })
    expect(store.getSession(session.id)?.acpSessionId).toBe(session.acpSessionId)
    expect(store.listMessages(session.id).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['first', 'second'])
  })

  it('keeps a running turn on its MCP configuration and reloads for the queued follow-up', async () => {
    state.canClose = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    state.script = async ({ say }) => { await gate; await say('done'); return 'end_turn' }
    const session = await manager.createSession('/project', 'claude')
    const first = manager.send(session.id, 'first', null)
    await vi.waitFor(() => expect(state.prompts).toHaveLength(1))
    servers = [{ name: 'next-tools', command: '/tools/mcp', args: [], env: [] }]
    await manager.refreshSession(session.id)
    expect(state.closes).toEqual([])
    expect(await manager.send(session.id, 'next', null)).toEqual({ queued: true })
    release()
    await first
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'turnEnd' && e.sessionId === session.id)).toHaveLength(2))
    expect(state.mcpRequests).toEqual([{ method: 'new', servers: [] }, { method: 'load', servers }])
    expect(state.prompts).toEqual(['first', 'next'])
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

    await manager.cancel(session.id)
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect(manager.openSession(session.id).turn).toBeNull()
  })

  describe('queue', () => {
    type Releases = Map<string, (stop?: acp.StopReason) => void>

    /** Turns wait until released by their prompt (wire) text, ending with `stop` (end_turn by default), or cancelled. */
    function holdTurns(): Releases {
      const releases: Releases = new Map()
      state.script = async ({ text, say, cancelled }) => {
        const released = new Promise<acp.StopReason>((r) => releases.set(text, (stop = 'end_turn') => r(stop)))
        const stop = await Promise.race([released, cancelled.then(() => 'cancelled' as const)])
        if (stop === 'end_turn') await say(`done: ${text}`)
        return stop
      }
      return releases
    }

    async function waitForPrompt(releases: Releases, text: string): Promise<void> {
      await vi.waitFor(() => expect(releases.has(text)).toBe(true))
    }

    /** A session whose turn 'one' is running and whose queue holds `queued`. */
    async function busy(releases: Releases, ...queued: string[]) {
      const session = await manager.createSession('/w', 'fake')
      const running = manager.send(session.id, 'one', null)
      await waitForPrompt(releases, 'one')
      for (const text of queued) await expect(manager.send(session.id, text, null)).resolves.toEqual({ queued: true })
      return { sessionId: session.id, running }
    }

    const texts = (sessionId: string): string[] => manager.openSession(sessionId).queue.items.map((q) => q.text)

    it('sends messages queued during a turn in order when it ends, each in its own thread', async () => {
      const releases = holdTurns()
      const session = await manager.createSession('/w', 'fake')
      const first = manager.send(session.id, 'review', null)
      await waitForPrompt(releases, 'review')
      releases.get('review')!()
      await first
      const agentMessage = manager.openSession(session.id).messages.find((m) => m.role === 'agent')!
      const thread = manager.createThread(session.id, agentMessage.id, { kind: 'listItem', path: [0], text: 'Item' })

      const running = manager.send(session.id, 'one', null)
      await waitForPrompt(releases, 'one')
      await expect(manager.send(session.id, 'two', thread.id)).resolves.toEqual({ queued: true })
      await expect(manager.send(session.id, 'three', null)).resolves.toEqual({ queued: true })
      expect(manager.openSession(session.id).queue.items.map((q) => [q.text, q.threadId])).toEqual([
        ['two', thread.id],
        ['three', null]
      ])
      expect(state.prompts).toEqual(['review', 'one'])

      releases.get('one')!()
      await expect(running).resolves.toEqual({ stopReason: 'end_turn' })
      // The next message starts as this turn ends, so it doesn't notify.
      expect(events).toContainEqual({
        type: 'turnEnd',
        sessionId: session.id,
        threadId: null,
        stopReason: 'end_turn',
        continues: true
      })
      const wireTwo = '[re: "Item"]\ntwo'
      await waitForPrompt(releases, wireTwo)
      expect(manager.openSession(session.id).turn).toEqual({ threadId: thread.id })
      expect(texts(session.id)).toEqual(['three'])

      releases.get(wireTwo)!()
      // 'three' is back in the main thread after a thread message: it says so.
      const wireThree = '[re: the main conversation, not the thread above]\nthree'
      await waitForPrompt(releases, wireThree)
      releases.get(wireThree)!()
      await vi.waitFor(() => expect(manager.openSession(session.id).turn).toBeNull())

      expect(state.prompts).toEqual(['review', 'one', wireTwo, wireThree])
      expect(manager.openSession(session.id).queue).toEqual({ items: [], paused: false })
      expect(events.filter((e) => e.type === 'turnEnd').at(-1)).not.toHaveProperty('continues')
      const messages = manager.openSession(session.id).messages
      expect(messages.find((m) => m.text === 'two')?.threadId).toBe(thread.id)
      expect(messages.find((m) => m.text === `done: ${wireTwo}`)?.threadId).toBe(thread.id)
    })

    it('moves on after a cancelled turn: the cancel stops only that turn', async () => {
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two')
      await manager.cancel(sessionId)
      await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
      expect(events.filter((e) => e.type === 'turnEnd').at(-1)).toMatchObject({ stopReason: 'cancelled', continues: true })
      await waitForPrompt(releases, 'two')
      expect(manager.openSession(sessionId).queue).toEqual({ items: [], paused: false })
      releases.get('two')!()
      await vi.waitFor(() => expect(manager.openSession(sessionId).turn).toBeNull())
    })

    it('records how each turn ended on its message, kept across a reopen', async () => {
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two', 'three')
      await manager.cancel(sessionId)
      await running
      await waitForPrompt(releases, 'two')
      releases.get('two')!('max_tokens')
      await vi.waitFor(() => expect(manager.openSession(sessionId).turn).toBeNull())
      manager.resumeQueue(sessionId)
      await waitForPrompt(releases, 'three')
      expect(manager.openSession(sessionId).messages.find((m) => m.text === 'three')).not.toHaveProperty('outcome')
      releases.get('three')!()
      await vi.waitFor(() => expect(manager.openSession(sessionId).turn).toBeNull())

      const outcomes = manager
        .openSession(sessionId)
        .messages.filter((m) => m.role === 'user')
        .map((m) => [m.text, m.outcome])
      expect(outcomes).toEqual([
        ['one', 'cancelled'],
        ['two', 'failed'],
        ['three', 'completed']
      ])
      expect(events).toContainEqual({ type: 'message', message: expect.objectContaining({ text: 'three', outcome: 'completed' }) })
    })

    it('pauses after a cut-short turn and sends the next message on resume', async () => {
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two')
      releases.get('one')!('max_tokens')
      await expect(running).resolves.toEqual({ stopReason: 'max_tokens' })
      expect(manager.openSession(sessionId).queue).toMatchObject({ paused: true, items: [{ text: 'two' }] })
      expect(events.filter((e) => e.type === 'turnEnd').at(-1)).not.toHaveProperty('continues')
      expect(state.prompts).toEqual(['one'])

      manager.resumeQueue(sessionId)
      await waitForPrompt(releases, 'two')
      expect(manager.openSession(sessionId).queue).toEqual({ items: [], paused: false })
      releases.get('two')!()
      await vi.waitFor(() => expect(manager.openSession(sessionId).turn).toBeNull())
    })

    it('sends right away while paused, and moves on once a turn ends normally', async () => {
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two')
      releases.get('one')!('max_tokens')
      await running

      const direct = manager.send(sessionId, 'now', null)
      await waitForPrompt(releases, 'now')
      expect(texts(sessionId)).toEqual(['two'])
      releases.get('now')!()
      await expect(direct).resolves.toEqual({ stopReason: 'end_turn' })
      await waitForPrompt(releases, 'two')
      expect(manager.openSession(sessionId).queue).toEqual({ items: [], paused: false })
      releases.get('two')!()
      await vi.waitFor(() => expect(manager.openSession(sessionId).turn).toBeNull())
    })

    it('edits and removes queued messages until they are sent', async () => {
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two', 'three')
      const [two, three] = manager.openSession(sessionId).queue.items

      manager.editQueued(sessionId, two.id, '  TWO  ')
      expect(() => manager.editQueued(sessionId, two.id, '  ')).toThrow(/can't be empty/)
      manager.removeQueued(sessionId, three.id)
      expect(() => manager.removeQueued(sessionId, three.id)).toThrow(/already been sent/)
      expect(texts(sessionId)).toEqual(['TWO'])
      expect(events.at(-1)).toEqual({
        type: 'queue',
        sessionId,
        queue: { items: [{ ...two, text: 'TWO' }], paused: false }
      })

      releases.get('one')!()
      await running
      await waitForPrompt(releases, 'TWO')
      expect(() => manager.editQueued(sessionId, two.id, 'late')).toThrow(/already been sent/)
      releases.get('TWO')!()
      await vi.waitFor(() => expect(manager.openSession(sessionId).turn).toBeNull())
    })

    it('unpauses when the last paused message is removed', async () => {
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two')
      releases.get('one')!('max_tokens')
      await running
      manager.removeQueued(sessionId, manager.openSession(sessionId).queue.items[0].id)
      expect(manager.openSession(sessionId).queue).toEqual({ items: [], paused: false })
    })

    it('drops the queue when the session is deleted', async () => {
      state.canDelete = true
      const releases = holdTurns()
      const { sessionId, running } = await busy(releases, 'two')
      await manager.deleteSession(sessionId)
      await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
      expect(state.prompts).toEqual(['one'])
    })
  })

  describe('steering', () => {
    /** The running turn says "working", waits for a steer, answers it and ends. */
    function steerableTurn(): void {
      state.steering = true
      state.script = async ({ text, say, nextSteer }) => {
        if (text === 'idle') return 'end_turn'
        await say('working', 'm1')
        const steer = await nextSteer()
        await say(`ok: ${steer}`, 'm2')
        return 'end_turn'
      }
    }

    it('injects a message into the running turn and records it before the answer', async () => {
      steerableTurn()
      const session = await manager.createSession('/w', 'fake')
      expect(manager.openSession(session.id).live.steering).toBe(true)
      const running = manager.send(session.id, 'build it', null)
      await vi.waitFor(() =>
        expect(manager.openSession(session.id).messages.some((m) => m.text === 'working')).toBe(true)
      )

      await expect(manager.steer(session.id, 'skip the tests', null)).resolves.toEqual({ steered: true })
      await expect(running).resolves.toEqual({ stopReason: 'end_turn' })

      expect(state.prompts).toEqual(['build it'])
      expect(state.steers).toEqual([[{ type: 'text', text: 'skip the tests' }]])
      const messages = manager.openSession(session.id).messages
      expect(messages.map((m) => [m.role, m.text, m.steered ?? false])).toEqual([
        ['user', 'build it', false],
        ['agent', 'working', false],
        ['user', 'skip the tests', true],
        ['agent', 'ok: skip the tests', false]
      ])
      // Persisted, with the turn's outcome on both of its messages.
      expect(store.listMessages(session.id)[2].steered).toBe(true)
      expect(messages.filter((m) => m.role === 'user').map((m) => m.outcome)).toEqual(['completed', 'completed'])
    })

    it('steers only the thread the turn runs in, tagged for that thread', async () => {
      state.steering = true
      const session = await manager.createSession('/w', 'fake')
      state.script = async ({ say }) => {
        await say('1. Item')
        return 'end_turn'
      }
      await manager.send(session.id, 'list', null)
      const anchor = manager.openSession(session.id).messages.find((m) => m.role === 'agent')!
      const thread = manager.createThread(session.id, anchor.id, { kind: 'listItem', path: [0], text: 'Item' })
      steerableTurn()

      const running = manager.send(session.id, 'fix it', thread.id)
      await vi.waitFor(() => expect(state.prompts).toHaveLength(2))
      await expect(manager.steer(session.id, 'not that way', null)).rejects.toThrow(/thread the agent is working in/)
      await expect(manager.steer(session.id, 'smaller', thread.id)).resolves.toEqual({ steered: true })
      await running

      expect(state.steers).toEqual([[{ type: 'text', text: '[re: "Item"]\nsmaller' }]])
      const inThread = manager.openSession(session.id).messages.filter((m) => m.threadId === thread.id)
      expect(inThread.map((m) => m.text)).toEqual(['fix it', 'working', 'smaller', 'ok: [re: "Item"]\nsmaller'])
    })

    it('sends as usual when no turn is running', async () => {
      steerableTurn()
      const session = await manager.createSession('/w', 'fake')
      await expect(manager.steer(session.id, 'idle', null)).resolves.toEqual({ stopReason: 'end_turn' })
      expect(state.prompts).toEqual(['idle'])
      expect(state.steers).toEqual([])
    })

    it('queues the message first when the turn ends before it gets in', async () => {
      steerableTurn()
      state.turnEnding = true
      const session = await manager.createSession('/w', 'fake')
      const running = manager.send(session.id, 'build it', null)
      await vi.waitFor(() => expect(state.prompts).toHaveLength(1))
      await manager.send(session.id, 'later', null)

      await expect(manager.steer(session.id, 'idle', null)).resolves.toEqual({ queued: true })
      expect(manager.openSession(session.id).queue.items.map((q) => q.text)).toEqual(['idle', 'later'])
      expect(manager.openSession(session.id).messages.some((m) => m.steered)).toBe(false)
      state.turnEnding = false
      await manager.steer(session.id, 'go on', null)
      await running
      await vi.waitFor(() => expect(state.prompts).toEqual(['build it', 'idle', 'later']))
    })

    it("refuses to steer an agent that doesn't support it", async () => {
      state.script = async ({ cancelled }) => {
        await cancelled
        return 'cancelled'
      }
      const session = await manager.createSession('/w', 'fake')
      expect(manager.openSession(session.id).live.steering).toBe(false)
      const running = manager.send(session.id, 'build it', null)
      await vi.waitFor(() => expect(state.prompts).toHaveLength(1))
      await expect(manager.steer(session.id, 'faster', null)).rejects.toThrow(/Queue it instead/)
      await manager.cancel(session.id)
      await running
    })
  })

  it('resumes with session/load after a restart, keeping the log', async () => {
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

      // Back in the main thread, the first message says so; later ones are sent untagged.
      await manager.send(sessionId, 'ok, do 1 and 2', null)
      expect(state.prompts.at(-1)).toBe('[re: the main conversation, not the thread above]\nok, do 1 and 2')
      await manager.send(sessionId, 'and 3', null)
      expect(state.prompts.at(-1)).toBe('and 3')
      const back = manager.openSession(sessionId).messages.find((m) => m.text === 'ok, do 1 and 2')!
      expect(back.wireText).toBe('[re: the main conversation, not the thread above]\nok, do 1 and 2')
    })

    it('sends a reply to the main conversation from a thread, tagged as continuing it', async () => {
      const { sessionId, reviewId } = await reviewed()
      const thread = manager.createThread(sessionId, reviewId, { kind: 'listItem', path: [0], text: 'Cache invalidation' })
      await manager.send(sessionId, 'why?', thread.id)
      await manager.send(sessionId, 'fine, let us do all of them', null, [], thread.id)
      expect(state.prompts.at(-1)).toBe(
        '[re: "Cache invalidation", continued in the main conversation]\nfine, let us do all of them'
      )
      expect(events.findLast((e) => e.type === 'turnStart')).toEqual({ type: 'turnStart', sessionId, threadId: null })
      const sent = manager.openSession(sessionId).messages.find((m) => m.text === 'fine, let us do all of them')!
      expect(sent.threadId).toBeNull()
      // It already left the thread: the next main message goes untagged.
      await manager.send(sessionId, 'and test it', null)
      expect(state.prompts.at(-1)).toBe('and test it')
      await expect(manager.send(sessionId, 'x', thread.id, [], thread.id)).rejects.toThrow()
    })

    it('queues a reply sent to main during a turn with its tag', async () => {
      const { sessionId, reviewId } = await reviewed()
      const thread = manager.createThread(sessionId, reviewId, { kind: 'listItem', path: [0], text: 'Cache invalidation' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      state.script = async ({ say }) => {
        await gate
        await say('ok')
        return 'end_turn'
      }
      const turn = manager.send(sessionId, 'why?', thread.id)
      await vi.waitFor(() => expect(state.prompts).toHaveLength(2))
      await expect(manager.send(sessionId, 'moving on', null, [], thread.id)).resolves.toEqual({ queued: true })
      expect(manager.openSession(sessionId).queue.items).toMatchObject([{ threadId: null, fromThread: thread.id }])
      release()
      await turn
      await vi.waitFor(() =>
        expect(state.prompts.at(-1)).toBe('[re: "Cache invalidation", continued in the main conversation]\nmoving on')
      )
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

  describe('plans', () => {
    const plan = (...statuses: acp.PlanEntryStatus[]): acp.SessionUpdate => ({
      sessionUpdate: 'plan',
      entries: statuses.map((status, i) => ({
        content: `Step ${i + 1}`,
        priority: 'medium',
        status
      }))
    })

    it("records a turn's plan in its thread, updating it in place", async () => {
      state.script = async ({ say }) => {
        await say('1. **Batch the query**\n')
        return 'end_turn'
      }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'Review it', null)
      const review = manager.openSession(session.id).messages.find((m) => m.role === 'agent')!
      const thread = manager.createThread(session.id, review.id, {
        kind: 'listItem',
        path: [0],
        text: 'Batch the query'
      })

      state.script = async ({ say, update }) => {
        await update(plan()) // An empty plan before there is one is nothing to show.
        await say('On it.')
        await update(plan('in_progress', 'pending'))
        await say('Step 1 done.')
        await update(plan('completed', 'in_progress'))
        return 'end_turn'
      }
      await manager.send(session.id, 'Do it', thread.id)

      const view = manager.openSession(session.id)
      const inThread = view.messages.filter((m) => m.threadId === thread.id)
      expect(inThread.map((m) => [m.seq, m.text])).toEqual([
        [2, 'Do it'],
        [3, 'On it.'],
        [5, 'Step 1 done.']
      ])
      expect(view.plans).toEqual([
        {
          id: expect.any(String),
          sessionId: session.id,
          seq: 4,
          threadId: thread.id,
          entries: [
            { content: 'Step 1', priority: 'medium', status: 'completed' },
            { content: 'Step 2', priority: 'medium', status: 'in_progress' }
          ]
        }
      ])
      const planEvents = events.filter((e) => e.type === 'plan')
      expect(planEvents).toHaveLength(2)
      expect(new Set(planEvents.map((e) => e.type === 'plan' && e.plan.id)).size).toBe(1)

      // The next turn's plan is a new checklist; the earlier one keeps its last state.
      state.script = async ({ update }) => {
        await update(plan('completed', 'completed'))
        return 'end_turn'
      }
      await manager.send(session.id, 'Finish', null)
      const plans = manager.openSession(session.id).plans
      expect(plans.map((p) => [p.threadId, p.entries.map((e) => e.status)])).toEqual([
        [thread.id, ['completed', 'in_progress']],
        [null, ['completed', 'completed']]
      ])
    })

    it('records plans from an import replay, one per user message', async () => {
      state.sessions.add('cli-1')
      state.history.set('cli-1', [
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Fix it' },
          messageId: 'u1'
        },
        plan('in_progress'),
        plan('completed'),
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Again' },
          messageId: 'u2'
        },
        plan('pending')
      ])
      const session = await manager.importSession('/w', 'fake', 'cli-1', 'Old')
      const view = manager.openSession(session.id)
      expect(view.plans.map((p) => [p.seq, p.entries[0].status])).toEqual([
        [1, 'completed'],
        [3, 'pending']
      ])
      expect(view.messages.map((m) => [m.seq, m.text])).toEqual([
        [0, 'Fix it'],
        [2, 'Again']
      ])
    })

    it('/clear removes the plans with the rest of the log', async () => {
      state.script = async ({ update }) => {
        await update(plan('pending'))
        return 'end_turn'
      }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'Plan it', null)
      expect(manager.openSession(session.id).plans).toHaveLength(1)
      await manager.send(session.id, '/clear', null)
      expect(manager.openSession(session.id).plans).toEqual([])
    })
  })

  it('timestamps messages when they are recorded', async () => {
    const session = await manager.createSession('/w', 'fake')
    await manager.send(session.id, 'hi', null)
    expect(manager.openSession(session.id).messages.map((m) => m.createdAt)).toEqual([1000, 1000])
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

    it('/clear replaces the agent session in place and deletes the old one', async () => {
      state.canDelete = true
      const session = await manager.createSession('/w/shop', 'fake')
      await manager.send(session.id, 'hi', null)
      const message = manager.openSession(session.id).messages[1]
      manager.createThread(session.id, message.id, { kind: 'selection', start: 0, end: 5, text: 'Hello' })

      await expect(manager.send(session.id, ' /clear ', null)).resolves.toEqual({ cleared: true })
      expect(state.prompts).toEqual(['hi'])
      expect(state.deleted).toEqual([session.acpSessionId])
      const cleared = store.getSession(session.id)!
      expect(cleared.acpSessionId).not.toBe(session.acpSessionId)
      expect(cleared.title).toBe('hi')
      const view = manager.openSession(session.id)
      expect([view.messages, view.toolCalls, view.threads]).toEqual([[], [], []])
      expect(events).toContainEqual({ type: 'sessionCleared', sessionId: session.id })

      await manager.send(session.id, 'again', null)
      expect(state.prompts).toEqual(['hi', 'again'])
      expect(manager.openSession(session.id).session.title).toBe('hi')
    })

    it('/clear is run by Gloss when steered too, and refused during a turn', async () => {
      const session = await manager.createSession('/w', 'fake')
      await expect(manager.steer(session.id, '/clear', null)).resolves.toEqual({ cleared: true })
      expect(state.prompts).toEqual([])

      state.script = async ({ cancelled }) => {
        await cancelled
        return 'cancelled'
      }
      const turn = manager.send(session.id, 'long', null)
      await vi.waitFor(() => expect(state.prompts).toEqual(['long']))
      await expect(manager.send(session.id, '/clear', null)).rejects.toThrow(/Cancel the running turn/)
      await manager.cancel(session.id)
      await turn
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

    it('hides and deletes again an agent session Gloss deleted that the agent lists again', async () => {
      state.canList = true
      state.canDelete = true
      const deleted = await manager.createSession('/w', 'fake')
      await manager.deleteSession(deleted.id)
      const cleared = await manager.createSession('/w', 'fake')
      await manager.send(cleared.id, '/clear', null)
      // Claude Code's process rewrites the transcripts' metadata after the deletes.
      state.listed = [
        { sessionId: deleted.acpSessionId, cwd: '/w', title: 'Leftover' },
        { sessionId: cleared.acpSessionId, cwd: '/w', title: 'Leftover' }
      ]
      state.deleted = []
      expect(await manager.agentSessions('/w', 'fake')).toEqual([])
      await vi.waitFor(() =>
        expect(state.deleted.sort()).toEqual([deleted.acpSessionId, cleared.acpSessionId].sort())
      )
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

    it('dates an imported session by its listed time, so it keeps its place', async () => {
      state.sessions.add('cli-2')
      const listed = await manager.importSession('/w', 'fake', 'cli-2', 'Listed', '2026-10-05T00:00:00Z')
      expect(listed.createdAt).toBe(Date.parse('2026-10-05T00:00:00Z'))
    })

    it('removes a failed import', async () => {
      await expect(manager.importSession('/w', 'fake', 'missing', 'Gone')).rejects.toThrow()
      expect(manager.listSessions()).toEqual([])
    })

    it('asks to quit Codex when another Codex client holds the session', async () => {
      state.sessions.add('cli-1')
      state.loadInUse = true
      await expect(manager.importSession('/w', 'fake', 'cli-1', 'Busy')).rejects.toThrow(
        /^This session is open in Codex\. Quit Codex to continue here\.$/
      )
      expect(manager.listSessions()).toEqual([])

      state.loadInUse = false
      expect((await manager.importSession('/w', 'fake', 'cli-1', 'Busy')).acpSessionId).toBe('cli-1')
    })

    it("deletes the agent's copy of a listed session it can't load", async () => {
      state.canDelete = true
      await expect(manager.importSession('/w', 'fake', 'stub', 'Gone')).rejects.toThrow(/no conversation left/)
      expect(state.deleted).toEqual(['stub'])
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
    const EFFORT: acp.SessionConfigOption = {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
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
        effort: null,
        commands: [
          { name: 'clear', description: 'Start over with a fresh conversation' },
          { name: 'compact', description: 'Compact the context', hint: '[focus]' }
        ],
        usage: { used: 50_000, size: 200_000, cost: { amount: 0.12, currency: 'USD' } },
        rateLimits: [],
        permissions: 'auto',
        accepts: { image: true, file: true },
        steering: false
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
      await manager.setChoice(session.id, 'model', 'opus')
      expect(manager.openSession(session.id).live.model?.current).toBe('opus')
      expect(store.getSession(session.id)?.model).toBe('opus')

      // The agent forgets it (a fresh process); Gloss sets it again when resuming.
      state.configOptions = [MODEL]
      await manager.dispose()
      manager = makeManager()
      await manager.send(session.id, 'hi', null)
      expect(state.configChanges).toEqual([`${session.acpSessionId}:model=opus`, `${session.acpSessionId}:model=opus`])
    })

    it('sets the effort per session and re-applies it after the model on resume', async () => {
      state.configOptions = [MODEL, EFFORT]
      const session = await manager.createSession('/w', 'fake')
      // Claude's "default" is replaced by the level its adapter recommends.
      expect(manager.openSession(session.id).live.effort).toEqual({
        configId: 'effort',
        current: 'medium',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' }
        ]
      })
      await manager.setChoice(session.id, 'model', 'opus')
      await manager.setChoice(session.id, 'effort', 'high')
      expect(manager.openSession(session.id).live).toMatchObject({ model: { current: 'opus' }, effort: { current: 'high' } })
      expect(store.getSession(session.id)).toMatchObject({ model: 'opus', effort: 'high' })

      state.configOptions = [MODEL, EFFORT]
      await manager.dispose()
      manager = makeManager()
      await manager.send(session.id, 'hi', null)
      const id = session.acpSessionId
      expect(state.configChanges).toEqual([
        `${id}:effort=medium`,
        `${id}:model=opus`,
        `${id}:effort=high`,
        `${id}:model=opus`,
        `${id}:effort=high`
      ])
    })

    it('pins a level again when a model switch puts the effort back on default', async () => {
      state.configOptions = [MODEL, EFFORT]
      state.afterConfigChange = (configId, options) =>
        configId === 'model' ? options.map((o) => (o.id === 'effort' && o.type === 'select' ? { ...o, currentValue: 'default' } : o)) : options
      const session = await manager.createSession('/w', 'fake')
      await manager.setChoice(session.id, 'effort', 'high')
      await manager.setChoice(session.id, 'model', 'opus')
      expect(manager.openSession(session.id).live.effort?.current).toBe('high')
      const id = session.acpSessionId
      expect(state.configChanges).toEqual([`${id}:effort=medium`, `${id}:effort=high`, `${id}:model=opus`, `${id}:effort=high`])
    })

    it("follows the agent's config updates and skips an effort the model doesn't offer", async () => {
      state.configOptions = [MODEL, EFFORT]
      const session = await manager.createSession('/w', 'fake')
      await manager.setChoice(session.id, 'effort', 'high')
      // A model without effort levels: the agent drops the option.
      state.script = async ({ update }) => {
        await update({ sessionUpdate: 'config_option_update', configOptions: [MODEL] })
        return 'end_turn'
      }
      await manager.send(session.id, 'hi', null)
      expect(manager.openSession(session.id).live.effort).toBeNull()
      await expect(manager.setChoice(session.id, 'effort', 'high')).rejects.toThrow(/choice of effort/)

      state.configOptions = [MODEL]
      await manager.dispose()
      manager = makeManager()
      state.script = async () => 'end_turn'
      await manager.send(session.id, 'again', null)
      expect(state.configChanges).toEqual([`${session.acpSessionId}:effort=medium`, `${session.acpSessionId}:effort=high`])
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

  describe('shared sessions', () => {
    /** A turn taken in the agent's CLI: saved to the session's history, unseen by Gloss. */
    function cliTurn(acpSessionId: string, text: string, reply: string): void {
      state.clock++
      save(
        state,
        acpSessionId,
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, messageId: `cli-u${state.clock}` },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply }, messageId: `cli-a${state.clock}` }
      )
    }

    beforeEach(() => {
      state.canList = true
      state.canClose = true
      let n = 0
      // Like Claude Code, answers carry a message id that the replay repeats.
      state.script = async ({ say, text }) => {
        await say(`Re: ${text.split('\n').pop()}`, `a${++n}`)
        return 'end_turn'
      }
    })

    it('pulls in turns taken in the CLI before the next prompt, keeping ids and threads', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'first', null)
      const answer = manager.openSession(session.id).messages[1]
      const thread = manager.createThread(session.id, answer.id, { kind: 'selection', start: 0, end: 3, text: 'Re:' })
      await manager.send(session.id, 'in thread', thread.id)
      const before = manager.openSession(session.id).messages

      cliTurn(session.acpSessionId, 'from the cli', 'cli answer')
      cliTurn(session.acpSessionId, `${wireTag('Re:')}\nback in the thread`, 'thread answer')
      const changed = state.updatedAt.get(session.acpSessionId)!
      await manager.send(session.id, 'next', null)

      expect(state.closes).toEqual([session.acpSessionId])
      expect(state.loads).toEqual([session.acpSessionId])
      const view = manager.openSession(session.id)
      expect(view.messages.map((m) => [m.seq, m.text, m.threadId])).toEqual([
        [0, 'first', null],
        [1, 'Re: first', null],
        [2, 'in thread', thread.id],
        [3, 'Re: in thread', thread.id],
        [4, 'from the cli', null],
        [5, 'cli answer', null],
        [6, 'back in the thread', thread.id],
        [7, 'thread answer', thread.id],
        [8, 'next', null],
        [9, 'Re: next', null]
      ])
      expect(view.messages.slice(0, 4).map((m) => m.id)).toEqual(before.map((m) => m.id))
      expect(view.threads).toEqual([thread])
      // Messages from elsewhere are timed by the agent's last change before the load.
      expect(view.messages[4].createdAt).toBe(Date.parse(changed))
      expect(events).toContainEqual({ type: 'sessionSynced', sessionId: session.id })
    })

    it("gives the agent Gloss's instructions on session/new and session/load", async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'one', null)
      cliTurn(session.acpSessionId, 'from the cli', 'cli answer')
      await manager.refreshSession(session.id)
      expect(state.metas).toEqual([
        { method: 'new', meta: { instructions: 'new' } },
        { method: 'load', meta: { instructions: 'load' } }
      ])
    })

    it('places a reply sent to main from elsewhere in the main thread', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'first', null)
      const answer = manager.openSession(session.id).messages[1]
      const thread = manager.createThread(session.id, answer.id, { kind: 'selection', start: 0, end: 3, text: 'Re:' })
      await manager.send(session.id, 'in thread', thread.id)
      cliTurn(session.acpSessionId, `${toMainTag('Re:')}\nback to main`, 'main answer')
      await manager.refreshSession(session.id)
      expect(manager.openSession(session.id).messages.slice(4).map((m) => [m.text, m.threadId])).toEqual([
        ['back to main', null],
        ['main answer', null]
      ])
    })

    it("doesn't reload when nothing changed elsewhere", async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'one', null)
      await manager.send(session.id, 'two', null)
      await manager.refreshSession(session.id)
      expect(state.closes).toEqual([])
      expect(state.loads).toEqual([])
    })

    it('reloads an open session when its history changed elsewhere, but not during a turn', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'one', null)
      cliTurn(session.acpSessionId, 'from the cli', 'cli answer')
      await manager.refreshSession(session.id)
      expect(manager.openSession(session.id).messages.map((m) => m.text)).toEqual([
        'one',
        'Re: one',
        'from the cli',
        'cli answer'
      ])

      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      state.script = async ({ say }) => {
        await gate
        await say('done', 'a-late')
        return 'end_turn'
      }
      const turn = manager.send(session.id, 'slow', null)
      await vi.waitFor(() => expect(state.prompts.at(-1)).toBe('slow'))
      state.clock++
      touch(state, session.acpSessionId)
      await manager.refreshSession(session.id)
      expect(state.closes).toEqual([session.acpSessionId])
      release()
      await turn
    })

    it('keeps the history before a compaction, which the replay no longer has', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'one', null)
      await manager.send(session.id, 'two', null)
      // After a compaction, Claude Code's history starts at its summary.
      state.transcripts.set(session.acpSessionId, [
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.' },
          messageId: 'summary'
        },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Re: two' }, messageId: 'a2' }
      ])
      cliTurn(session.acpSessionId, 'three', 'Re: three')
      await manager.refreshSession(session.id)
      expect(manager.openSession(session.id).messages.map((m) => m.text)).toEqual([
        'one',
        'Re: one',
        'two',
        'Re: two',
        'three',
        'Re: three'
      ])
    })

    it("skips Claude Code's marker of a cancelled turn", async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'one', null)
      save(state, session.acpSessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '[Request interrupted by user]' },
        messageId: 'marker'
      })
      cliTurn(session.acpSessionId, 'go on', 'going')
      await manager.refreshSession(session.id)
      expect(manager.openSession(session.id).messages.map((m) => m.text)).toEqual(['one', 'Re: one', 'go on', 'going'])
    })

    it('removes what the agent no longer has, with the threads anchored there', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'one', null)
      const kept = state.transcripts.get(session.acpSessionId)!
      await manager.send(session.id, 'two', null)
      const answer = manager.openSession(session.id).messages[3]
      manager.createThread(session.id, answer.id, { kind: 'selection', start: 0, end: 3, text: 'Re:' })
      // Rewound in the CLI to after the first turn, then continued.
      state.transcripts.set(session.acpSessionId, kept)
      cliTurn(session.acpSessionId, 'instead', 'other answer')
      await manager.refreshSession(session.id)
      const view = manager.openSession(session.id)
      expect(view.messages.map((m) => m.text)).toEqual(['one', 'Re: one', 'instead', 'other answer'])
      expect(view.threads).toEqual([])
    })

    it('reads attached files back from the replay and keeps the ones Gloss sent', async () => {
      state.promptCapabilities = { embeddedContext: true }
      const file = { kind: 'file' as const, name: 'notes.md', path: fileURLToPath(pathToFileURL('/w/notes.md')), text: '# Notes' }
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'look', null, [file])
      cliTurn(session.acpSessionId, 'more', 'ok')
      await manager.refreshSession(session.id)
      expect(manager.openSession(session.id).messages.map((m) => [m.text, m.attachments])).toEqual([
        ['look', [file]],
        ['Re: look', undefined],
        ['more', undefined],
        ['ok', undefined]
      ])

      // Opened fresh from the agent's copy, the file comes back from the replay.
      state.sessions.add('cli-1')
      state.history.set('cli-1', state.transcripts.get(session.acpSessionId)!)
      const imported = await manager.importSession('/w', 'fake', 'cli-1', 'Copy')
      const look = manager.openSession(imported.id).messages[0]
      expect([look.text, look.attachments]).toEqual(['look', [{ kind: 'file', name: 'notes.md', path: file.path, text: '# Notes' }]])
    })

    it('deletes a session the agent no longer has, unless it never had a message', async () => {
      const used = await manager.createSession('/w', 'fake')
      await manager.send(used.id, 'hi', null)
      const unused = await manager.createSession('/w', 'fake')
      state.sessions.clear()
      await manager.dispose()
      manager = makeManager()

      manager.openSession(used.id)
      await vi.waitFor(() =>
        expect(events).toContainEqual({ type: 'sessionDeleted', sessionId: used.id, deletedOutside: { title: 'hi' } })
      )
      expect(store.getSession(used.id)).toBeUndefined()

      await expect(manager.send(unused.id, 'hello', null)).resolves.toEqual({ stopReason: 'end_turn' })
      expect(store.getSession(unused.id)?.acpSessionId).not.toBe(unused.acpSessionId)
      expect(events.some((e) => e.type === 'notice')).toBe(false)
    })

    it('reports other load failures instead of starting a new agent session', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'hi', null)
      await manager.dispose()
      manager = makeManager()
      state.failLoad = true
      const result = await manager.send(session.id, 'again', null)
      expect(result.error).toMatch(/couldn't resume it: .*transcript unreadable/)
      expect(store.getSession(session.id)?.acpSessionId).toBe(session.acpSessionId)
    })

    it('asks to quit Codex instead of starting a new session when Codex holds it', async () => {
      const session = await manager.createSession('/w', 'fake')
      await manager.send(session.id, 'hi', null)
      await manager.dispose()
      manager = makeManager()
      state.loadInUse = true
      const result = await manager.send(session.id, 'again', null)
      expect(result.error).toBe('This session is open in Codex. Quit Codex to continue here.')
      expect(store.getSession(session.id)?.acpSessionId).toBe(session.acpSessionId)
    })

    it("takes the agent's title unless the session was renamed in Gloss", async () => {
      const session = await manager.createSession('/w', 'fake')
      state.listed = [{ sessionId: session.acpSessionId, cwd: '/w', title: 'Fix the  build' }]
      await manager.agentSessions('/w', 'fake')
      expect(store.getSession(session.id)?.title).toBe('Fix the build')
      manager.renameSession(session.id, 'Mine')
      state.listed = [{ sessionId: session.acpSessionId, cwd: '/w', title: 'Something else' }]
      await manager.agentSessions('/w', 'fake')
      expect(store.getSession(session.id)?.title).toBe('Mine')
    })
  })

  describe('review sessions', () => {
    const DIFF: ReviewDiff = {
      baseRef: 'origin/main',
      base: 'base123',
      headRef: null,
      head: 'head456',
      files: [
        {
          path: 'src/a.ts',
          status: 'modified',
          binary: false,
          state: 'committed',
          additions: 2,
          deletions: 0,
          hunks: [
            {
              header: '@@ -10,1 +10,3 @@',
              lines: [
                { kind: 'context', old: 10, new: 10, text: 'const a = 1' },
                { kind: 'add', old: null, new: 11, text: 'const b = 2' },
                { kind: 'add', old: null, new: 12, text: 'const c = 3' }
              ]
            }
          ]
        }
      ]
    }
    const FINDINGS = [
      'The change adds two constants.',
      '```gloss-findings',
      JSON.stringify([
        { file: 'src/a.ts', side: 'new', start: 11, end: 12, severity: 'bug', title: 'Unused constants', body: 'Nothing reads b or c.' },
        { file: 'src/elsewhere.ts', side: 'new', start: 3, end: 3, severity: 'nit', title: 'Not in the diff', body: '' }
      ]),
      '```'
    ].join('\n')
    const lineAnchor = { kind: 'line' as const, file: 'src/a.ts', side: 'new' as const, start: 10, end: 10, text: 'const a = 1', lines: ['const a = 1'] }

    const OPEN_PR: PullRequest = {
      number: 7,
      title: 'Add constants',
      url: 'https://github.com/o/r/pull/7',
      state: 'open',
      checks: null,
      review: null,
      baseRef: 'main'
    }
    /** The branch's pull request, as gh reports it. */
    let pr: PullRequest | null

    function reviewManager(): SessionManager {
      return new SessionManager({
        store,
        emit: (e) => events.push(e),
        getAgentConfig: () => ({ ...config, sessionMeta: (instructions) => ({ new: { instructions }, load: { instructions } }) }),
        agentEnv: () => ({ FAKE: '1' }),
        connect: (_config, _env, handlers) => AgentConnection.open(agentApp(state), handlers),
        runInTerminal: runInTerminal as never,
        now: () => 1000,
        git: {
          pullRequest: async () => pr,
          pullRequestBase: async (_cwd, branch) => `origin/${branch}`,
          defaultBranch: async () => 'origin/trunk',
          currentBranch: async () => 'feature',
          mergeBase: async (_cwd, ref) => `mb:${ref}`,
          commits: async (_cwd, since) => [{ sha: 'c1', subject: `since ${since}`, at: 1 }],
          repoUrl: async () => 'https://github.com/o/r',
          readDiff: async (_cwd, baseRef, headRef) =>
            headRef === null ? DIFF : { ...DIFF, baseRef, base: baseRef, headRef, head: 'commit789' },
          readFile: async () => null
        }
      })
    }

    /** Starts a review and waits for its first pass to end. */
    async function startReview(): Promise<Session> {
      const session = await manager.createReview('/repo', 'fake')
      await vi.waitFor(() => expect(events.some((e) => e.type === 'turnEnd' && e.sessionId === session.id)).toBe(true))
      return session
    }

    beforeEach(async () => {
      pr = OPEN_PR
      await manager.dispose()
      manager = reviewManager()
      state.script = async ({ say, text }) => {
        await say(isFirstPass(text) ? FINDINGS : `Re: ${text.split('\n').pop()}`)
        return 'end_turn'
      }
    })

    it('starts a new review of a given range', async () => {
      const sha = 'b'.repeat(40)
      const session = await manager.createReview('/repo', 'fake', { baseRef: sha, headRef: 'HEAD' })
      await vi.waitFor(() => expect(state.prompts).toHaveLength(1))
      expect(session).toMatchObject({ title: 'Review: feature', review: { baseRef: sha, headRef: 'HEAD' } })
      expect(state.prompts[0]).toContain(`\`git diff ${sha} commit789\``)
      expect(state.prompts[0]).not.toContain('pull request')
    })

    it('reviews against the default branch without an open pull request', async () => {
      pr = { ...OPEN_PR, state: 'merged' }
      const session = await manager.createReview('/repo', 'fake')
      await vi.waitFor(() => expect(state.prompts).toHaveLength(1))
      expect(session).toMatchObject({ title: 'Review: feature', review: { baseRef: 'origin/trunk' } })
      expect(session.review?.headRef).toBeUndefined()
      expect(state.prompts[0]).not.toContain('pull request')
    })

    it('offers merge bases and commits, and tells the agent once when the range changes', async () => {
      const session = await startReview()
      // The pull request's base is the default, so it comes first.
      expect(await manager.reviewRefs(session.id)).toEqual({
        bases: [
          { ref: 'origin/main', sha: 'mb:origin/main' },
          { ref: 'origin/trunk', sha: 'mb:origin/trunk' }
        ],
        commits: [{ sha: 'c1', subject: 'since mb:origin/trunk', at: 1 }],
        repoUrl: 'https://github.com/o/r',
        defaultBase: 'origin/main'
      })

      const sha = 'a'.repeat(40)
      const diff = await manager.setReviewRange(session.id, { baseRef: sha, headRef: 'HEAD' })
      expect(diff).toMatchObject({ base: sha, headRef: 'HEAD', head: 'commit789' })
      expect(store.getSession(session.id)?.review).toEqual({ baseRef: sha, headRef: 'HEAD' })
      expect(events).toContainEqual({ type: 'session', session: expect.objectContaining({ review: { baseRef: sha, headRef: 'HEAD' } }) })
      await expect(manager.setReviewRange(session.id, { baseRef: '--output=x' })).rejects.toThrow('Not a commit')

      await manager.send(session.id, 'Look again', null)
      const note = `[The diff under review is now \`git diff ${sha} commit789\`.]`
      expect(state.prompts[1]).toBe(`${note}\nLook again`)
      const sent = store.listMessages(session.id).filter((m) => m.role === 'user').pop()
      expect(sent).toMatchObject({ text: 'Look again', wireText: `${note}\nLook again` })
      await manager.send(session.id, 'And again', null)
      expect(state.prompts[2]).toBe('And again')
    })

    it('starts with the first pass, with the review instructions, and opens a thread per finding on the diff', async () => {
      const session = await startReview()
      expect(session).toMatchObject({ title: 'Review: #7 Add constants', titleSet: true, review: { baseRef: 'origin/main' } })
      expect(state.prompts).toHaveLength(1)
      expect(isFirstPass(state.prompts[0])).toBe(true)
      expect(state.prompts[0]).toContain('git diff base123')
      expect((state.metas[0].meta as { instructions: string }).instructions).toContain(REVIEW_INSTRUCTIONS)

      const threads = store.listThreads(session.id)
      expect(threads).toHaveLength(1)
      expect(threads[0]).toMatchObject({
        anchorMessageId: null,
        anchor: { kind: 'line', file: 'src/a.ts', side: 'new', start: 11, end: 12, lines: ['const b = 2', 'const c = 3'] },
        finding: { severity: 'bug', title: 'Unused constants', body: 'Nothing reads b or c.' }
      })
      expect(events).toContainEqual({ type: 'thread', thread: threads[0] })
      expect(store.getSession(session.id)?.openThreads).toBe(1)

      // The same findings listed again open nothing new.
      state.script = async ({ say }) => (await say(FINDINGS), 'end_turn')
      await manager.send(session.id, 'Review again', null)
      expect(store.listThreads(session.id)).toHaveLength(1)
    })

    it('tags line threads with the file and lines, and resolves and reopens them', async () => {
      const session = await startReview()
      const thread = manager.createThread(session.id, null, lineAnchor)
      expect(manager.createThread(session.id, null, { ...lineAnchor, text: 'const' })).toEqual(thread)
      await manager.send(session.id, 'Why a constant?', thread.id)
      expect(state.prompts.at(-1)).toBe('[re: src/a.ts:10 "const a = 1"]\nWhy a constant?')
      expect(store.getSession(session.id)?.openThreads).toBe(2)

      const resolved = manager.resolveThread(session.id, thread.id, true)
      expect(resolved.resolvedAt).toBe(1000)
      expect(store.getThread(thread.id)?.resolvedAt).toBe(1000)
      expect(store.getSession(session.id)?.openThreads).toBe(1)
      expect(manager.resolveThread(session.id, thread.id, false).resolvedAt).toBeUndefined()
      expect(store.getSession(session.id)?.openThreads).toBe(2)
    })

    it('keeps line anchors to review sessions, with a valid range', async () => {
      const chat = await manager.createSession('/repo', 'fake')
      expect(() => manager.createThread(chat.id, null, lineAnchor)).toThrow(/review session/)
      const review = await startReview()
      expect(() => manager.createThread(review.id, null, { ...lineAnchor, end: 12 })).toThrow(/Invalid thread anchor/)
      expect(() => manager.resolveThread(chat.id, 'nope', true)).toThrow(/Unknown thread/)
    })

    it('reads the diff for the renderer, only for a review', async () => {
      const review = await startReview()
      expect(await manager.reviewDiff(review.id)).toBe(DIFF)
      const chat = await manager.createSession('/repo', 'fake')
      expect(() => manager.reviewDiff(chat.id)).toThrow(/Only a review session/)
    })

    it('places messages from the CLI tagged with a line thread back in that thread', async () => {
      state.canList = true
      state.canClose = true
      const session = await startReview()
      const thread = manager.createThread(session.id, null, lineAnchor)
      await manager.send(session.id, 'in the thread', thread.id)
      save(
        state,
        session.acpSessionId,
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `${threadTag(lineAnchor)}\nfrom the cli` }, messageId: 'cli-u' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cli answer' }, messageId: 'cli-a' }
      )
      await manager.refreshSession(session.id)
      const fromCli = store.listMessages(session.id).find((m) => m.text === 'from the cli')
      expect(fromCli?.threadId).toBe(thread.id)
      expect(store.listMessages(session.id).find((m) => m.text === 'cli answer')?.threadId).toBe(thread.id)
      // Line threads have no message to go with: they survive the sync.
      expect(store.getThread(thread.id)).toBeDefined()
    })
  })
})
