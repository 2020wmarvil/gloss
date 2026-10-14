import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './db'

describe('Store', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('persists across reopen and keeps one sequence for messages and tool calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-db-'))
    dirs.push(dir)
    const path = join(dir, 'gloss.db')

    let store = new Store(path)
    store.insertSession({ id: 's', agentId: 'claude', acpSessionId: 'a', cwd: '/w', title: 'w', createdAt: 1 })
    const handoff = { sessionId: 'original', threadId: 'thread', title: 'Original', agentId: 'codex', quote: 'anchor' }
    store.updateSession('s', { handoff })
    expect(store.nextSeq('s')).toBe(0)
    store.insertMessage({ id: 'm0', sessionId: 's', seq: 0, role: 'user', text: 'hi', wireText: 'hi', threadId: null })
    store.upsertToolCall({ id: 't', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read', status: 'pending', content: [{ type: 'content' }] })
    store.upsertToolCall({ id: 't', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read a.ts', status: 'completed' })
    expect(store.nextSeq('s')).toBe(2)
    store.close()

    store = new Store(path) // migrations must be a no-op the second time
    expect(store.listSessions().map((s) => s.id)).toEqual(['s'])
    expect(store.getSession('s')?.handoff).toEqual(handoff)
    expect(store.listMessages('s')).toEqual([
      { id: 'm0', sessionId: 's', seq: 0, role: 'user', text: 'hi', wireText: 'hi', threadId: null }
    ])
    expect(store.listToolCalls('s')).toEqual([
      { id: 't', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read a.ts', status: 'completed' }
    ])
    expect(store.updateSession('s', { title: 'New', acpSessionId: 'b' })).toMatchObject({ title: 'New', acpSessionId: 'b' })
    store.close()
  })

  it('lists sessions by their newest message, else when they were made', () => {
    const store = new Store(':memory:')
    for (const [id, createdAt] of [['old', 1], ['new', 5], ['busy', 2]] as const) {
      store.insertSession({ id, agentId: 'claude', acpSessionId: id, cwd: '/w', title: id, createdAt })
    }
    store.insertMessage({ id: 'm', sessionId: 'busy', seq: 0, role: 'user', text: 'hi', threadId: null, createdAt: 9 })
    expect(store.listSessions().map((s) => [s.id, s.activeAt])).toEqual([
      ['busy', 9],
      ['new', 5],
      ['old', 1]
    ])
    store.close()
  })

  it("lists the user's messages from every session, newest first and each once", () => {
    const store = new Store(':memory:')
    for (const id of ['a', 'b']) {
      store.insertSession({ id, agentId: 'claude', acpSessionId: id, cwd: '/w', title: id, createdAt: 1 })
    }
    store.insertMessage({ id: 'm0', sessionId: 'a', seq: 0, role: 'user', text: '/review XYZ', threadId: null, createdAt: 1 })
    store.insertMessage({ id: 'm1', sessionId: 'a', seq: 1, role: 'agent', text: 'done', threadId: null, createdAt: 2 })
    store.insertMessage({ id: 'm2', sessionId: 'b', seq: 0, role: 'user', text: 'why?', threadId: 't', createdAt: 3 })
    store.insertMessage({ id: 'm3', sessionId: 'b', seq: 1, role: 'user', text: '/review XYZ', threadId: null, createdAt: 4 })
    store.insertMessage({ id: 'm4', sessionId: 'b', seq: 2, role: 'user', text: '', threadId: null, createdAt: 5 })
    expect(store.messageHistory()).toEqual(['/review XYZ', 'why?'])
    expect(store.messageHistory(1)).toEqual(['/review XYZ'])
    store.close()
  })

  it('resequences the log, inserting new entries where they belong', () => {
    const store = new Store(':memory:')
    store.insertSession({ id: 's', agentId: 'claude', acpSessionId: 'a', cwd: '/w', title: 'w', createdAt: 1 })
    store.insertMessage({ id: 'm0', sessionId: 's', seq: 0, role: 'user', text: 'a', threadId: null })
    store.insertMessage({ id: 'm1', sessionId: 's', seq: 1, role: 'agent', text: 'b', threadId: null })
    store.transaction(() =>
      store.resequence('s', [
        { kind: 'message', id: 'm0' },
        { insert: (seq) => store.insertMessage({ id: 'x', sessionId: 's', seq, role: 'user', text: 'new', threadId: null }) },
        { kind: 'message', id: 'm1' }
      ])
    )
    expect(store.listMessages('s').map((m) => [m.seq, m.id])).toEqual([
      [0, 'm0'],
      [1, 'x'],
      [2, 'm1']
    ])
    store.close()
  })
})
