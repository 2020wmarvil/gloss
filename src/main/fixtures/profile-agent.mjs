// A deterministic ACP subprocess used by profile integration tests. No model or network.
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const instructionsFile = process.argv[2] || process.env.GLOSS_INSTRUCTIONS
const instructions = readFileSync(instructionsFile, 'utf8')
const historyFile = join(process.env.GLOSS_PROFILE_DATA, 'history.json')
let sessions = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : {}
let held
const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n')
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const persist = () => writeFileSync(historyFile, JSON.stringify(sessions))

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  const result = (value) => send({ id, result: value })
  switch (method) {
    case 'initialize':
      if (process.env.GLOSS_HANG_INIT) break
      if (process.env.GLOSS_FAIL_INIT) {
        send({ id, error: { code: -32603, message: `Agent initialization timed out ${process.env.GLOSS_TEST_SECRET}` } })
        break
      }
      result({ protocolVersion: process.env.GLOSS_BAD_PROTOCOL ? 999 : 1, agentInfo: { name: 'profile-test', version: '1.0.0' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} }, promptCapabilities: { image: true, embeddedContext: true } } })
      break
    case 'session/new': {
      const sessionId = `profile-${Object.keys(sessions).length}`
      sessions[sessionId] = { cwd: params.cwd, updates: [] }
      persist()
      result({ sessionId })
      break
    }
    case 'session/list':
      result({ sessions: Object.entries(sessions).filter(([, s]) => !params.cwd || s.cwd === params.cwd).map(([sessionId, s]) => ({ sessionId, cwd: s.cwd })) })
      break
    case 'session/load':
      for (const value of sessions[params.sessionId].updates) update(params.sessionId, value)
      result({})
      break
    case 'session/close': result({}); break
    case 'session/prompt': {
      const text = params.prompt.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      const command = text.split('\n').at(-1)
      if (command === 'fail-secret') {
        process.stderr.write(process.env.GLOSS_TEST_SECRET + '\n')
        send({ id, error: { code: -32603, message: process.env.GLOSS_TEST_SECRET, data: { token: process.env.GLOSS_TEST_SECRET } } })
        break
      }
      if (command === 'auth-error') {
        send({ id, error: { code: -32000, message: process.env.GLOSS_TEST_SECRET } })
        break
      }
      if (command === 'hold') {
        held = { id, sessionId: params.sessionId }
        update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'hold', title: 'Waiting for cancellation', kind: 'other', status: 'in_progress' })
        break
      }
      if (command === 'write-file') {
        const path = join(sessions[params.sessionId].cwd, 'profile-result.txt')
        update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'write', title: 'Write file', kind: 'edit', status: 'in_progress' })
        writeFileSync(path, 'Written through a custom ACP profile.\n')
        update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed' })
      }
      const answer = instructions.includes('[re:') ? `Instructions loaded. ${text}` : 'Instructions missing'
      const updates = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } }
      ]
      sessions[params.sessionId].updates.push(...updates)
      persist()
      update(params.sessionId, updates[1])
      result({ stopReason: 'end_turn' })
      break
    }
    case 'session/cancel':
      if (held) { send({ id: held.id, result: { stopReason: 'cancelled' } }); held = undefined }
      break
    default: send({ id, error: { code: -32601, message: 'Unsupported method' } })
  }
})
