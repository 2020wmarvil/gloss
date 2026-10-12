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
    expect(store.nextSeq('s')).toBe(0)
    store.insertMessage({ id: 'm0', sessionId: 's', seq: 0, role: 'user', text: 'hi', wireText: 'hi', threadId: null })
    store.upsertToolCall({ id: 't', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read', status: 'pending', content: [{ type: 'content' }] })
    store.upsertToolCall({ id: 't', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read a.ts', status: 'completed' })
    expect(store.nextSeq('s')).toBe(2)
    store.close()

    store = new Store(path) // migrations must be a no-op the second time
    expect(store.listSessions().map((s) => s.id)).toEqual(['s'])
    expect(store.listMessages('s')).toEqual([
      { id: 'm0', sessionId: 's', seq: 0, role: 'user', text: 'hi', wireText: 'hi', threadId: null }
    ])
    expect(store.listToolCalls('s')).toEqual([
      { id: 't', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read a.ts', status: 'completed' }
    ])
    expect(store.updateSession('s', { title: 'New', acpSessionId: 'b' })).toMatchObject({ title: 'New', acpSessionId: 'b' })
    store.close()
  })
})
