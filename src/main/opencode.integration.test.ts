// Opt in with GLOSS_OPENCODE_EXECUTABLE. Real ACP transport, local mock inference only.
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentConnection } from './acp'
import { agentEnv } from './agents'
import { OpenCodeSupport } from './opencode'
import { AgentProfileSupport } from './agentProfiles'
import { Store } from './db'
import { SessionManager } from './sessions'
import { AGENT_INSTRUCTIONS } from '../shared/wire'

afterEach(() => vi.unstubAllEnvs())

it.skipIf(!process.env.GLOSS_OPENCODE_EXECUTABLE).each(['guided', 'custom'])('runs OpenCode v2 (%s) with native instructions, threads, process restart and cancellation', async (mode) => {
  const executable = process.env.GLOSS_OPENCODE_EXECUTABLE!
  const dir = mkdtempSync(join(tmpdir(), 'gloss-opencode-integration-'))
  const cwd = join(dir, 'project')
  mkdirSync(cwd)
  const payloads: Record<string, unknown>[] = []
  let held: ServerResponse | undefined
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const payload = JSON.parse(body)
    payloads.push(payload)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (JSON.stringify(payload.messages.at(-1)).includes('hold-for-cancel')) {
      res.write(': waiting\n\n')
      held = res
      return
    }
    const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'probe',
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`
    if (payload.messages.at(-1)?.role === 'user' && JSON.stringify(payload.messages.at(-1)).includes('write-probe-file') && payload.tools?.some((t: { function: { name: string } }) => t.function.name === 'write')) {
      res.write(chunk({ role: 'assistant', tool_calls: [{
        index: 0, id: 'call-write-probe', type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ path: join(cwd, 'probe.txt'), content: 'Written through ACP.\n' }) }
      }] }))
      res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
      return
    }
    res.write(chunk({ role: 'assistant', content: 'Hello from the local probe.' }))
    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({
    model: 'gloss-test/probe', update: 'disable', snapshots: false,
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'gloss-test', effect: 'allow' }
    ],
    providers: {
      'gloss-test': {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-test' },
        models: { probe: { name: 'Local probe', limit: { context: 65536, output: 1024 } } }
      }
    }
  }))
  const support = new OpenCodeSupport(join(dir, 'gloss'))
  const config = mode === 'guided' ? support.config(executable) : new AgentProfileSupport(join(dir, 'gloss')).config({
    id: 'custom:opencode', name: 'OpenCode custom', command: process.execPath,
    args: [resolve('scripts/opencode-custom-acp.mjs'), executable, '{instructions}'], env: {}
  })
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|systemdrive)$/i.test(key))),
    HOME: dir, USERPROFILE: dir, APPDATA: join(dir, 'roaming'), LOCALAPPDATA: join(dir, 'local'),
    XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT
  }
  const store = new Store(join(dir, 'gloss.db'))
  const makeManager = (): SessionManager => new SessionManager({
    store, emit() {}, getAgentConfig: () => config,
    agentEnv: (c) => agentEnv(c, env), connect: (c, e, h) => AgentConnection.start(c, e, h),
    runInTerminal: async () => { throw new Error('No interactive login in this test') }
  })
  let manager = makeManager()
  try {
    const session = await manager.createSession(cwd, 'opencode')
    expect((await manager.openSession(session.id)).live.model?.current).toContain('probe')
    expect(await manager.send(session.id, 'hello', null)).toMatchObject({ stopReason: 'end_turn' })
    const first = store.listMessages(session.id)
    expect(first.map((m) => m.text)).toContain('Hello from the local probe.')
    expect(payloads.some((p) => JSON.stringify(p.messages).includes(AGENT_INSTRUCTIONS.split('\n')[0]))).toBe(true)
    const answer = first.find((m) => m.role === 'agent')!
    const thread = manager.createThread(session.id, answer.id, { kind: 'selection', start: 0, end: 5, text: 'Hello' })
    await manager.send(session.id, 'thread reply', thread.id)
    await manager.dispose()
    manager = makeManager()
    await manager.send(session.id, 'after restart', thread.id)
    expect(store.listThreads(session.id)).toContainEqual(thread)
    expect(store.listMessages(session.id).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['hello', 'thread reply', 'after restart'])
    expect(store.listMessages(session.id).filter((m) => m.role === 'agent')).toHaveLength(3)
    expect(store.listMessages(session.id).filter((m) => m.text === 'after restart')[0].threadId).toBe(thread.id)
    expect(await manager.send(session.id, 'write-probe-file', null)).toMatchObject({ stopReason: 'end_turn' })
    expect(readFileSync(join(cwd, 'probe.txt'), 'utf8')).toBe('Written through ACP.\n')
    expect(store.listToolCalls(session.id).some((t) => t.status === 'completed')).toBe(true)
    const pending = manager.send(session.id, 'hold-for-cancel', null)
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 10000 })
    await manager.cancel(session.id)
    expect(await pending).toMatchObject({ stopReason: 'cancelled' })
    console.log('OpenCode integration: native instructions, model selection, streamed text, threads, process restart/replay and cancellation passed.')
  } finally {
    await manager.dispose()
    store.close()
    held?.end()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 60000)

it.skipIf(!process.env.GLOSS_OPENCODE_EXECUTABLE || !process.env.GLOSS_OPENCODE_LIVE_OLLAMA)('uses an installed Ollama model without hosted credentials', async () => {
  const executable = process.env.GLOSS_OPENCODE_EXECUTABLE!
  const dir = mkdtempSync(join(tmpdir(), 'gloss-opencode-ollama-'))
  const cwd = join(dir, 'project')
  mkdirSync(cwd)
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({
    model: 'ollama/qwen3.5:latest', update: 'disable', snapshots: false,
    providers: { ollama: { models: { 'qwen3.5:latest': { body: { think: false, reasoning_effort: 'none', max_tokens: 512 }, limit: { output: 512 } } } } },
    agents: { title: { disabled: true } },
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'ollama', effect: 'allow' }
    ]
  }))
  const config = new OpenCodeSupport(join(dir, 'gloss')).config(executable)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|systemdrive)$/i.test(key))),
    HOME: dir, USERPROFILE: dir, APPDATA: join(dir, 'roaming'), LOCALAPPDATA: join(dir, 'local'),
    XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true'
  }
  const store = new Store(join(dir, 'gloss.db'))
  const manager = new SessionManager({
    store, emit() {}, getAgentConfig: () => config,
    agentEnv: (c) => agentEnv(c, env), connect: (c, e, h) => AgentConnection.start(c, e, h),
    runInTerminal: async () => { throw new Error('No hosted login allowed') }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const session = await manager.createSession(cwd, 'opencode')
    const live = (await manager.openSession(session.id)).live
    expect(live.model?.current).toContain('qwen3.5')
    timer = setTimeout(() => { void manager.cancel(session.id) }, 30000)
    expect(await manager.send(session.id, 'Reply with exactly GLOSS_LOCAL_OK and nothing else. Do not use tools.', null)).toMatchObject({ stopReason: 'end_turn' })
    expect(store.listMessages(session.id).some((m) => m.role === 'agent' && m.text.includes('GLOSS_LOCAL_OK'))).toBe(true)
    clearTimeout(timer)
    timer = setTimeout(() => { void manager.cancel(session.id) }, 30000)
    expect(await manager.send(session.id, 'Use the write tool to create local-proof.txt in the current directory containing exactly GLOSS_LOCAL_FILE_OK. Do not run commands. After writing, reply DONE.', null)).toMatchObject({ stopReason: 'end_turn' })
    expect(readFileSync(join(cwd, 'local-proof.txt'), 'utf8').trim()).toBe('GLOSS_LOCAL_FILE_OK')
    expect(store.listToolCalls(session.id).some((t) => t.status === 'completed')).toBe(true)
  } finally {
    clearTimeout(timer)
    await manager.dispose()
    store.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 90000)
