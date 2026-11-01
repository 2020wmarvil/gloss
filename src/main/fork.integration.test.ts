// Opt in with GLOSS_CLAUDE_LIVE=1 and/or GLOSS_CODEX_LIVE=1. Fork threads (SPEC → Fork threads) through the
// real adapters and the user's logins: Claude on Haiku, Codex on its default model. Makes model calls.
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FORK_SUMMARY_PROMPT } from '../shared/wire'
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gloss-fork-live-'))
  store = new Store(':memory:')
  manager = new SessionManager({
    store,
    emit: () => {},
    getAgentConfig,
    agentEnv: (config) => agentEnv(config, cleanEnv()),
    connect: (config, env, handlers) => AgentConnection.start(config, env, handlers),
    runInTerminal: async () => 1,
    permissionMode: () => 'bypass'
  })
})

afterEach(async () => {
  // Deleting the session deletes its forks' agent copies too.
  for (const s of store.listSessions()) await manager.deleteSession(s.id).catch(() => {})
  await manager.dispose()
  store.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await rm(join(homedir(), '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true }).catch(() => {})
})

const agentText = (sessionId: string, threadId: string | null): string =>
  store.listMessages(sessionId).filter((m) => m.role === 'agent' && m.threadId === threadId).at(-1)?.text.toUpperCase() ?? ''

async function scenario(agentId: string, sleep: string): Promise<void> {
  const session = await manager.createSession(dir, agentId)
  expect((await manager.send(session.id, 'Remember the word APPLE. Reply with one short numbered list of two items: "1. rename" and "2. test".', null)).error).toBeUndefined()
  const answer = store.listMessages(session.id).find((m) => m.role === 'agent')!

  // Fork while the main conversation runs a shell command.
  const main = manager.send(session.id, `Remember the word BANANA, then run the shell command \`${sleep}\`, then say DONE.`, null)
  for (let i = 0; i < 1200 && store.listToolCalls(session.id).length === 0; i++) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 1500))
  const thread = await manager.createForkThread(session.id, answer.id, { kind: 'selection', start: 0, end: 5, text: answer.text.slice(0, 5) })
  const forkId = thread.fork!.sessionId

  // It answers while main is still working, and knows the history up to the fork.
  const side = await manager.send(session.id, 'List every word I asked you to remember, comma separated, nothing else. Also remember CHERRY.', thread.id)
  expect(side.error).toBeUndefined()
  expect(manager.openSession(session.id).turn).not.toBeNull()
  const listed = agentText(forkId, thread.id)
  console.log(`[live ${agentId}] fork: ${listed}`)
  expect(listed).toContain('APPLE')
  expect(listed).toContain('BANANA')
  expect(store.getSession(forkId)!.forkOf).toEqual({ sessionId: session.id, threadId: thread.id })
  expect((await main).error).toBeUndefined()

  // Send to main carries the fork's summary; main never saw the thread otherwise.
  const sent = await manager.send(session.id, 'What word did the side thread add? Reply with the word only.', null, [], thread.id)
  expect(sent.error).toBeUndefined()
  expect(store.listMessages(forkId).some((m) => m.wireText === FORK_SUMMARY_PROMPT)).toBe(true)
  const reply = agentText(session.id, null)
  console.log(`[live ${agentId}] main: ${reply}`)
  expect(reply).toContain('CHERRY')
}

it.skipIf(!process.env.GLOSS_CLAUDE_LIVE)('claude: a fork thread runs beside a running main turn and summarizes to main', async () => {
  await scenario('claude', 'sleep 15')
}, 600_000)

it.skipIf(!process.env.GLOSS_CODEX_LIVE)('codex: a fork thread runs beside a running main turn and summarizes to main', async () => {
  await scenario('codex', 'Start-Sleep 15')
}, 600_000)
