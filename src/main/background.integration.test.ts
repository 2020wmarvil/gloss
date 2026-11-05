// Background jobs and Restart on the real agents (SPEC → Background jobs). Each job writes a marker
// file when it ends, so a stopped job is one whose marker never appears.
// Opt in: GLOSS_BACKGROUND_LIVE=1 for Claude Code (on Haiku) and Codex with the user's logins;
// GLOSS_OPENCODE_EXECUTABLE for OpenCode, with its config isolated and a local fake model.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlossEvent } from '../shared/ipc'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig } from './agents'
import { Store } from './db'
import { OpenCodeSupport } from './opencode'
import { SessionManager } from './sessions'

const JOB_SECONDS = 25
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function cleanEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)))
  return { ...env, ANTHROPIC_MODEL: 'haiku' }
}

let dir: string
let store: Store
let events: GlossEvent[]
let manager: SessionManager

function turnEnds(sessionId: string): Extract<GlossEvent, { type: 'turnEnd' }>[] {
  return events.filter((e): e is Extract<GlossEvent, { type: 'turnEnd' }> => e.type === 'turnEnd' && e.sessionId === sessionId)
}

/** A first exchange and a thread on it, for the job to start in. */
async function threadOn(sessionId: string): Promise<string> {
  await manager.send(sessionId, 'Reply with just the word HELLO.', null)
  const answer = store.listMessages(sessionId).filter((m) => m.role === 'agent').at(-1)!
  return manager.createThread(sessionId, answer.id, { kind: 'selection', start: 0, end: 1, text: answer.text.slice(0, 1) }).id
}

describe.skipIf(!process.env.GLOSS_BACKGROUND_LIVE)('with the real adapters', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-background-live-'))
    store = new Store(':memory:')
    events = []
    manager = new SessionManager({
      store,
      emit: (e) => events.push(e),
      getAgentConfig,
      agentEnv: (config) => agentEnv(config, cleanEnv()),
      connect: (config, env, handlers) => AgentConnection.start(config, env, handlers),
      runInTerminal: async () => 1,
      permissionMode: () => 'bypass'
    })
  })

  afterEach(async () => {
    await manager.dispose()
    store.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  })

  const claudeJob = (marker: string): string =>
    `Use the Bash tool with run_in_background set to true to run exactly: sleep ${JOB_SECONDS}; echo finished > ${marker}\nDo not wait for it or check on it. Then reply with just the word STARTED and end your turn.`
  const codexJob = (marker: string): string =>
    `Start this command in a background terminal using exec_command with yield_time_ms 1000, and do not poll or wait for it: powershell -NoProfile -Command "Start-Sleep ${JOB_SECONDS}; Set-Content ${marker} finished"\nAfter starting it, reply with just the word STARTED and end your turn.`

  it('Claude Code: shows the job, puts the follow-up in its thread, and Restart stops the next one', async () => {
    const session = await manager.createSession(dir, 'claude')
    const thread = await threadOn(session.id)

    await manager.send(session.id, claudeJob('first.txt'), thread)
    expect(turnEnds(session.id).at(-1)).toMatchObject({ stopReason: 'end_turn', jobsRunning: true })
    expect(existsSync(join(dir, 'first.txt'))).toBe(false)
    const view = manager.openSession(session.id)
    expect(view.turn).toBeNull()
    expect(view.background).toEqual([thread])
    expect(manager.isAgentBusy('claude')).toBe(true)
    await expect(manager.restartIdleAgent('claude')).resolves.toBe(false)

    const agentMessages = store.listMessages(session.id).filter((m) => m.role === 'agent').length
    await vi.waitFor(() => expect(manager.openSession(session.id).background).toEqual([]), { timeout: (JOB_SECONDS + 20) * 1000, interval: 500 })
    expect(existsSync(join(dir, 'first.txt'))).toBe(true)
    await vi.waitFor(() => {
      const agent = store.listMessages(session.id).filter((m) => m.role === 'agent')
      expect(agent.length).toBeGreaterThan(agentMessages)
      expect(agent.at(-1)?.threadId).toBe(thread)
      expect(manager.openSession(session.id).turn).toBeNull()
    }, { timeout: 30000, interval: 500 })
    expect(turnEnds(session.id).at(-1)).not.toHaveProperty('jobsRunning')

    await manager.send(session.id, claudeJob('second.txt'), null)
    expect(manager.openSession(session.id).background).toEqual([null])
    const messages = store.listMessages(session.id).length
    await manager.restartSession(session.id)
    expect(manager.openSession(session.id).background).toEqual([])
    expect(manager.openSession(session.id).live.attached).toBe(true)
    expect(store.listMessages(session.id).length).toBeGreaterThanOrEqual(messages)
    await sleep((JOB_SECONDS + 5) * 1000)
    expect(existsSync(join(dir, 'second.txt'))).toBe(false)

    // The session still works, and remembers.
    const result = await manager.send(session.id, 'What word did I first ask you to reply with? Reply with just that word.', null)
    expect(result).toMatchObject({ stopReason: 'end_turn' })
    expect(store.listMessages(session.id).filter((m) => m.role === 'agent').at(-1)?.text).toMatch(/HELLO/i)
  }, 240000)

  it('Codex: keeps the running command from failing, records its end, and Restart stops the next one', async () => {
    const session = await manager.createSession(dir, 'codex')
    await manager.setChoice(session.id, 'model', 'gpt-5.6-luna')
    const thread = await threadOn(session.id)

    await manager.send(session.id, codexJob('first.txt'), thread)
    expect(turnEnds(session.id).at(-1)).toMatchObject({ stopReason: 'end_turn', jobsRunning: true })
    const job = store.listToolCalls(session.id).find((t) => t.status === 'in_progress')
    expect(job, 'the command should still be running').toBeDefined()
    expect(manager.openSession(session.id).background).toEqual([thread])
    await expect(manager.restartIdleAgent('codex')).resolves.toBe(false)
    const ends = turnEnds(session.id).length

    await vi.waitFor(() => expect(manager.openSession(session.id).background).toEqual([]), { timeout: (JOB_SECONDS + 20) * 1000, interval: 500 })
    expect(existsSync(join(dir, 'first.txt'))).toBe(true)
    expect(store.getToolCall(session.id, job!.id)?.status).toBe('completed')
    await vi.waitFor(() => expect(turnEnds(session.id).length).toBe(ends + 1), { timeout: 5000 })
    expect(turnEnds(session.id).at(-1)).toMatchObject({ stopReason: 'end_turn', threadId: thread })

    await manager.send(session.id, codexJob('second.txt'), null)
    const second = store.listToolCalls(session.id).find((t) => t.status === 'in_progress')
    expect(second, 'the second command should still be running').toBeDefined()
    expect(manager.openSession(session.id).background).toEqual([null])
    await manager.restartSession(session.id)
    expect(manager.openSession(session.id).background).toEqual([])
    expect(manager.openSession(session.id).live.attached).toBe(true)
    expect(['failed', 'cancelled']).toContain(store.getToolCall(session.id, second!.id)?.status)
    expect(manager.openSession(session.id).live.model?.current).toContain('gpt-5.6-luna')
    expect(store.listMessages(session.id).map((m) => m.text).join('\n')).not.toContain('This session was recorded with model')
    await sleep((JOB_SECONDS + 5) * 1000)
    expect(existsSync(join(dir, 'second.txt'))).toBe(false)

    expect(await manager.send(session.id, 'Reply with just the word AGAIN.', null)).toMatchObject({ stopReason: 'end_turn' })
  }, 300000)
})

describe.skipIf(!process.env.GLOSS_OPENCODE_EXECUTABLE)('with OpenCode and a fake model', () => {
  const executable = process.env.GLOSS_OPENCODE_EXECUTABLE!
  let cwd: string
  /** How long the model takes to answer a tool result. */
  let slowToolReply = 0
  let command = ''
  let served: ReturnType<typeof createServer>

  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const payload = JSON.parse(body) as { tools?: unknown[]; messages: { role: string; content: unknown }[] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta: object, finish: string | null = null): string =>
      `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const last = payload.messages.at(-1)!
    const text = JSON.stringify(last.content)
    if (last.role === 'user' && text.includes('start-the-job') && payload.tools?.length) {
      res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command, background: true }) } }] }))
      res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
      return
    }
    if (last.role === 'tool' && slowToolReply) await sleep(slowToolReply)
    const reply = last.role === 'tool' ? 'STARTED' : text.includes('state=') ? 'THE JOB ENDED' : 'HELLO'
    res.write(chunk({ role: 'assistant', content: reply }))
    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-background-opencode-'))
    cwd = join(dir, 'project')
    mkdirSync(cwd)
    slowToolReply = 0
    served = createServer((req, res) => void answer(req, res))
    await new Promise<void>((resolve) => served.listen(0, '127.0.0.1', resolve))
    const port = (served.address() as { port: number }).port
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
    const config = new OpenCodeSupport(join(dir, 'gloss')).config(executable)
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext|temp|tmp|systemdrive)$/i.test(key))),
      HOME: dir, USERPROFILE: dir, APPDATA: join(dir, 'roaming'), LOCALAPPDATA: join(dir, 'local'),
      XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'),
      XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'),
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT
    }
    store = new Store(':memory:')
    events = []
    manager = new SessionManager({
      store,
      emit: (e) => events.push(e),
      getAgentConfig: () => config,
      agentEnv: (c) => agentEnv(c, env),
      connect: (c, e, h) => AgentConnection.start(c, e, h),
      runInTerminal: async () => 1,
      quietJobPollMs: 500
    })
  })

  afterEach(async () => {
    await manager.dispose()
    store.close()
    vi.unstubAllEnvs()
    served.closeAllConnections()
    await new Promise<void>((resolve) => served.close(() => resolve()))
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
  })

  const jobOf = (ms: number): string => `node -e "setTimeout(()=>require('fs').writeFileSync('marker.txt','x'),${ms})"`

  it('shows the job until its follow-up lands in the thread that started it', async () => {
    command = jobOf(6000)
    const session = await manager.createSession(cwd, 'opencode')
    const thread = await threadOn(session.id)
    await manager.send(session.id, 'start-the-job', thread)
    expect(turnEnds(session.id).at(-1)).toMatchObject({ stopReason: 'end_turn', jobsRunning: true })
    expect(manager.openSession(session.id).background).toEqual([thread])
    expect(existsSync(join(cwd, 'marker.txt'))).toBe(false)

    await vi.waitFor(() => expect(manager.openSession(session.id).background).toEqual([]), { timeout: 30000, interval: 200 })
    expect(existsSync(join(cwd, 'marker.txt'))).toBe(true)
    await vi.waitFor(() => expect(store.listMessages(session.id).at(-1)).toMatchObject({ text: 'THE JOB ENDED', threadId: thread }), { timeout: 10000 })
    await vi.waitFor(() => expect(turnEnds(session.id).at(-1)).not.toHaveProperty('jobsRunning'), { timeout: 5000 })
  }, 90000)

  it('sees a job that ends during its own turn', async () => {
    command = jobOf(500)
    slowToolReply = 3000
    const session = await manager.createSession(cwd, 'opencode')
    await manager.send(session.id, 'start-the-job', null)
    expect(manager.openSession(session.id).background).toEqual([])
    expect(turnEnds(session.id).at(-1)).not.toHaveProperty('jobsRunning')
    expect(store.listMessages(session.id).at(-1)?.text).toBe('THE JOB ENDED')
  }, 60000)

  it("restarts a session, whose job goes on and is no longer tracked", async () => {
    command = jobOf(6000)
    const session = await manager.createSession(cwd, 'opencode')
    await manager.send(session.id, 'start-the-job', null)
    expect(manager.openSession(session.id).background).toEqual([null])
    await manager.restartSession(session.id)
    expect(manager.openSession(session.id).background).toEqual([])
    expect(manager.openSession(session.id).live.attached).toBe(true)
    expect(store.listMessages(session.id).some((m) => m.text === 'STARTED')).toBe(true)
    await vi.waitFor(() => expect(existsSync(join(cwd, 'marker.txt'))).toBe(true), { timeout: 15000, interval: 200 })
    expect(await manager.send(session.id, 'hello again', null)).toMatchObject({ stopReason: 'end_turn' })
  }, 60000)
})
