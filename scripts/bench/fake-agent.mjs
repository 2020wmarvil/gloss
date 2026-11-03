// The benchmark's ACP agent (M25), run as a custom profile: replays the seeded history on
// session/load and streams long code-heavy answers at a realistic rate. No model or network.
// Usage: node fake-agent.mjs <data folder> <instructions file>
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { answer, random, toolCall } from './content.mjs'

const dir = process.argv[2]
const histories = new Map()
let turns = 0
const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n')
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })

function history(sessionId) {
  let h = histories.get(sessionId)
  if (!h) {
    const file = join(dir, `${sessionId}.json`)
    h = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { cwd: '', updates: [] }
    histories.set(sessionId, h)
  }
  return h
}

/** How a turn streams, from `config.json` (the driver changes it between scenarios). */
function config() {
  const file = join(dir, 'config.json')
  return { chars: 16000, chunk: [6, 18], intervalMs: 30, toolCalls: 3, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) }
}

/** The running turn of each session, so session/cancel can end it. */
const running = new Map()

async function prompt(id, params) {
  const { sessionId } = params
  const h = history(sessionId)
  const n = turns++
  for (const block of params.prompt) {
    if (block.type === 'text' || block.type === 'image') h.updates.push({ sessionUpdate: 'user_message_chunk', messageId: `live-u-${n}`, content: block })
  }
  const text = params.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const c = config()
  const short = text.includes('bench:short')
  const r = random(10_000 + n)
  const full = answer(r, short ? 600 : c.chars)
  const tools = short ? 0 : c.toolCalls
  const turn = { cancelled: false }
  running.set(sessionId, turn)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let messageId = `live-a-${n}-0`
  let part = 0
  const emit = (value) => {
    h.updates.push(value)
    update(sessionId, value)
  }
  // Tool calls spread through the answer, each splitting it into another message.
  const breaks = new Set(Array.from({ length: tools }, (_, i) => Math.floor(((i + 1) * full.length) / (tools + 1))))
  for (let at = 0; at < full.length && !turn.cancelled; ) {
    const size = r.int(c.chunk[0], c.chunk[1])
    let next = Math.min(full.length, at + size)
    const brk = [...breaks].find((b) => b > at && b <= next)
    if (brk !== undefined) next = brk
    emit({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: full.slice(at, next) } })
    at = next
    if (brk !== undefined) {
      breaks.delete(brk)
      const t = toolCall(r, `live-t-${n}-${part}`)
      emit({ sessionUpdate: 'tool_call', toolCallId: t.toolCallId, title: t.title, kind: t.kind, status: 'in_progress' })
      await wait(c.intervalMs * 4)
      emit({ sessionUpdate: 'tool_call_update', toolCallId: t.toolCallId, status: 'completed', content: t.content })
      messageId = `live-a-${n}-${++part}`
    }
    await wait(c.intervalMs)
  }
  running.delete(sessionId)
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(h))
  send({ id, result: { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' } })
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return
  const { id, method, params } = JSON.parse(line)
  if (id === undefined && method !== 'session/cancel') return
  const result = (value) => send({ id, result: value })
  switch (method) {
    case 'initialize':
      result({
        protocolVersion: 1,
        agentInfo: { name: 'gloss-bench', version: '1.0.0' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} }, promptCapabilities: { image: true, embeddedContext: true } }
      })
      break
    case 'session/new': {
      const sessionId = `bench-new-${Date.now()}-${turns++}`
      histories.set(sessionId, { cwd: params.cwd, updates: [] })
      result({ sessionId })
      break
    }
    case 'session/load': {
      for (const value of history(params.sessionId).updates) update(params.sessionId, value)
      result({})
      break
    }
    case 'session/close':
      result({})
      break
    case 'session/prompt':
      void prompt(id, params)
      break
    case 'session/cancel': {
      const turn = running.get(params.sessionId)
      if (turn) turn.cancelled = true
      break
    }
    default:
      send({ id, error: { code: -32601, message: `Unsupported method ${method}` } })
  }
})
