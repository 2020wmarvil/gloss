// Opt in with GLOSS_CLAUDE_LIVE=1 and/or GLOSS_CODEX_LIVE=1. Native rewind (SPEC → Rewind) through the real
// adapters and the user's logins: Claude on Haiku, Codex on its default model. Makes model calls.
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Attachment } from '../shared/types'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig } from './agents'
import { Store } from './db'
import { SessionManager } from './sessions'

/** The environment without the host Claude Code session's variables, on Haiku. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)))
  return { ...env, ANTHROPIC_MODEL: 'haiku' }
}

let dir: string
let store: Store
let manager: SessionManager
/** Every agent session the test made (rewinds leave the source behind), to delete afterwards. */
let made: { agentId: string; acpSessionId: string }[]

function makeManager(): SessionManager {
  return new SessionManager({
    store,
    emit: () => {},
    getAgentConfig,
    agentEnv: (config) => agentEnv(config, cleanEnv()),
    connect: (config, env, handlers) => AgentConnection.start(config, env, handlers),
    runInTerminal: async () => 1,
    permissionMode: () => 'bypass'
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gloss-rewind-live-'))
  store = new Store(':memory:')
  manager = makeManager()
  made = []
})

afterEach(async () => {
  await manager.dispose()
  for (const agentId of new Set(made.map((m) => m.agentId))) {
    const config = getAgentConfig(agentId)
    const conn = await AgentConnection.start(config, agentEnv(config, cleanEnv()), {
      onUpdate: () => {},
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onStderr: () => {},
      onClosed: () => {}
    })
    for (const m of made.filter((x) => x.agentId === agentId)) await conn.deleteSession(m.acpSessionId).catch(() => {})
    conn.dispose()
  }
  store.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await rm(join(homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true }).catch(() => {})
})

function png(r: number, g: number, b: number): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const size = 64
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([r, g, b], y * (size * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

const ASK = 'List every word I asked you to remember and the color of every image I sent, comma separated, nothing else.'

function track(agentId: string, sessionId: string): void {
  const acpSessionId = store.getSession(sessionId)!.acpSessionId
  if (!acpSessionId.startsWith('gloss-')) made.push({ agentId, acpSessionId })
}

function userMessage(sessionId: string, includes: string): string {
  return store.listMessages(sessionId).find((m) => m.role === 'user' && m.text.includes(includes))!.id
}

async function ask(agentId: string, sessionId: string): Promise<string> {
  const result = await manager.send(sessionId, ASK, null)
  expect(result.error).toBeUndefined()
  track(agentId, sessionId)
  const answer = store.listMessages(sessionId).filter((m) => m.role === 'agent').at(-1)!.text
  console.log(`[live ${agentId}] ${answer}`)
  return answer.toUpperCase()
}

async function scenario(agentId: string, sleep: string): Promise<void> {
  const session = await manager.createSession(dir, agentId)
  const red: Attachment = { kind: 'image', name: 'red.png', mimeType: 'image/png', data: png(255, 0, 0) }
  const send = async (text: string, attachments: Attachment[] = []): Promise<void> => {
    expect((await manager.send(session.id, text, null, attachments)).error).toBeUndefined()
    track(agentId, session.id)
  }
  await send('Remember the color of this image. Reply in one line.', [red])
  await send('Remember the word APPLE. Then run the shell command `echo one` and reply in one line.')
  await send('Remember the word BANANA. Reply in one line.')

  // Cancel mid tool call, then rewind it at once, as double Escape does.
  const turn = manager.send(session.id, `Remember the word CHERRY, then run the shell command \`${sleep}\`, then say DONE.`, null)
  for (let i = 0; i < 1200 && store.listToolCalls(session.id).length < 2; i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 1000))
  await manager.cancel(session.id)
  expect((await turn).stopReason).toBe('cancelled')
  track(agentId, session.id)
  expect(manager.rewindPoints(session.id)[0].text).toContain('CHERRY')
  await manager.rewindSession(session.id, userMessage(session.id, 'CHERRY'))
  let answer = await ask(agentId, session.id)
  expect(answer).toContain('APPLE')
  expect(answer).toContain('BANANA')
  expect(answer).toContain('RED')
  expect(answer).not.toContain('CHERRY')

  // A repeated rewind, to the middle.
  await manager.rewindSession(session.id, userMessage(session.id, 'BANANA'))
  expect(store.listMessages(session.id).some((m) => m.text.includes('BANANA') || m.text.includes('CHERRY'))).toBe(false)
  answer = await ask(agentId, session.id)
  expect(answer).toContain('APPLE')
  expect(answer).toContain('RED')
  expect(answer).not.toContain('BANANA')

  // After a restart the discarded turns stay gone, on both sides.
  const before = store.listMessages(session.id).map((m) => m.id)
  await manager.dispose()
  manager = makeManager()
  answer = await ask(agentId, session.id)
  expect(store.listMessages(session.id).map((m) => m.id).slice(0, before.length)).toEqual(before)
  expect(answer).toContain('APPLE')
  expect(answer).not.toContain('BANANA')
  expect(answer).not.toContain('CHERRY')
}

it.skipIf(!process.env.GLOSS_CLAUDE_LIVE)('claude: rewinds natively through cancellation, repeated rewinds and a restart', async () => {
  await scenario('claude', 'sleep 30')
}, 600_000)

it.skipIf(!process.env.GLOSS_CODEX_LIVE)('codex: rewinds natively through cancellation, repeated rewinds and a restart', async () => {
  await scenario('codex', 'Start-Sleep 30')
}, 600_000)
