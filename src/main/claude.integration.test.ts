// Opt in with GLOSS_CLAUDE_LIVE=1. The real Claude adapter and the user's Claude login, on Haiku
// (SPEC → Questions and approvals): AskUserQuestion through a form elicitation, and Manual mode's
// approval prompts.
import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { GlossEvent } from '../shared/ipc'
import type { UserRequest } from '../shared/requests'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig } from './agents'
import { Store } from './db'
import { SessionManager } from './sessions'

const live = it.skipIf(!process.env.GLOSS_CLAUDE_LIVE)

/** The environment without the host Claude Code session's variables, on Haiku. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)))
  return { ...env, ANTHROPIC_MODEL: 'haiku' }
}

let dir: string
let store: Store
let events: GlossEvent[]
let manager: SessionManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gloss-claude-live-'))
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
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** The next request the session waits on that hasn't been seen yet. */
async function nextRequest(sessionId: string, seen: Set<string>): Promise<UserRequest> {
  for (let i = 0; i < 1200; i++) {
    const open = manager.openSession(sessionId).requests.find((r) => !seen.has(r.id))
    if (open) {
      seen.add(open.id)
      return open
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('The agent never asked.')
}

function lastAgentText(sessionId: string): string {
  return store.listMessages(sessionId).filter((m) => m.role === 'agent').map((m) => m.text).join('\n')
}

live('asks a multiple-choice question mid-turn, even in bypass mode, and gets the answer', async () => {
  const session = await manager.createSession(dir, 'claude')
  expect(manager.openSession(session.id).live.modes?.current).toBe('bypassPermissions')
  const turn = manager.send(
    session.id,
    'Use the AskUserQuestion tool to ask me one single-select question: "Which color?" with the options Red, Green and Blue. ' +
      'After I answer, reply with only the color I picked, nothing else.',
    null
  )
  const request = await nextRequest(session.id, new Set())
  console.log('[live] question:', JSON.stringify(request, null, 2))
  expect(request.kind).toBe('question')
  if (request.kind !== 'question') return
  const choice = request.fields.find((f) => f.kind === 'choice')
  expect(choice && choice.kind === 'choice' && choice.options.map((o) => o.value)).toEqual(['Red', 'Green', 'Blue'])
  manager.answerRequest(session.id, request.id, { kind: 'question', action: 'accept', content: { [choice!.key]: 'Green' } })
  await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
  console.log('[live] answer:', lastAgentText(session.id))
  expect(lastAgentText(session.id)).toMatch(/Green/)
}, 240_000)

live('in Manual mode asks before an edit and continues or stops on the answer', async () => {
  const session = await manager.createSession(dir, 'claude')
  await manager.setMode(session.id, 'default')
  expect(manager.openSession(session.id).live).toMatchObject({ modes: { current: 'default' }, autoApprove: false })
  const seen = new Set<string>()

  const denied = manager.send(session.id, 'Use the Write tool to create a file named no.txt here containing "no". Do not use any other tool.', null)
  const first = await nextRequest(session.id, seen)
  console.log('[live] approval:', JSON.stringify(first, null, 2))
  expect(first.kind).toBe('permission')
  if (first.kind !== 'permission') return
  const reject = first.options.find((o) => o.kind.startsWith('reject'))!
  manager.answerRequest(session.id, first.id, { kind: 'permission', optionId: reject.id })
  await denied
  expect(existsSync(join(dir, 'no.txt'))).toBe(false)

  const allowed = manager.send(session.id, 'Now use the Write tool to create a file named yes.txt here containing "yes".', null)
  const second = await nextRequest(session.id, seen)
  expect(second.kind).toBe('permission')
  if (second.kind !== 'permission') return
  const allow = second.options.find((o) => o.kind === 'allow_once')!
  manager.answerRequest(session.id, second.id, { kind: 'permission', optionId: allow.id })
  await expect(allowed).resolves.toEqual({ stopReason: 'end_turn' })
  expect(existsSync(join(dir, 'yes.txt'))).toBe(true)
}, 300_000)
