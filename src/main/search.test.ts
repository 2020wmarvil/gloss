import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from './db'
import type { SearchRequest } from '../shared/search'

const request = (query: string, rest: Partial<SearchRequest> = {}): SearchRequest => ({ query, scope: 'all', kind: 'all', ...rest })
function seed(store: Store): void {
  for (const [id, cwd] of [['a', 'C:/Work'], ['b', '/other']]) {
    store.insertSession({ id, cwd, agentId: 'claude', acpSessionId: id, title: `Session ${id}`, createdAt: 1 })
    store.insertMessage({ id: `m${id}`, sessionId: id, seq: 0, role: 'user', text: 'cache key format', threadId: null })
  }
  store.insertThread({ id: 'thread', sessionId: 'a', anchorMessageId: 'ma', anchor: { kind: 'selection', start: 0, end: 5, text: 'cache' }, createdAt: 1 })
  store.insertMessage({ id: 'reply', sessionId: 'a', seq: 1, role: 'agent', text: 'Use cache version key format', threadId: 'thread' })
  store.upsertToolCall({ id: 'tool', sessionId: 'a', messageSeq: 2, threadId: 'thread', title: 'Read config', status: 'completed', content: [
    { type: 'content', content: { type: 'text', text: 'cache key format from output <script>alert(1)</script>' } },
    { type: 'content', content: { type: 'image', data: 'hiddenimagepayload', mimeType: 'image/png' } }
  ] })
}

describe('full-text search', () => {
  it('searches messages and tool output with scopes, filters, safe phrases and thread metadata', () => {
    const store = new Store(':memory:')
    try {
      seed(store)
      expect(store.search(request('cache format')).results).toHaveLength(4)
      expect(store.search(request('"cache key"')).results.map((r) => r.id).sort()).toEqual(['ma', 'mb', 'tool'])
      expect(store.search(request('cache', { scope: 'project', cwd: 'c:\\work\\' })).results).toHaveLength(3)
      expect(store.search(request('cache', { scope: 'session', sessionId: 'b' })).results.map((r) => r.id)).toEqual(['mb'])
      expect(store.search(request('cache', { kind: 'agent' })).results[0]).toMatchObject({ id: 'reply', threadId: 'thread', threadQuote: 'cache', sessionTitle: 'Session a' })
      expect(store.search(request('cache', { kind: 'user' })).results).toHaveLength(2)
      expect(store.search(request('cache', { kind: 'tool' })).results[0].snippet).toContain('\u0001cache\u0002')
      expect(store.search(request('hiddenimagepayload')).results).toEqual([])
      for (const query of ['', '  ', '"', '*', '() OR', 'cache -', 'cache "', 'cache:format', '"cache key']) expect(() => store.search(request(query))).not.toThrow()
      expect(() => store.search(request('cache', { scope: 'session' }))).toThrow('needs a session')
    } finally { store.close() }
  })

  it('updates indexes transactionally through streaming, resequencing, syncs and cascading deletes', () => {
    const store = new Store(':memory:')
    try {
      seed(store)
      store.updateMessageText('reply', 'replacementword')
      expect(store.search(request('version')).results).toEqual([])
      expect(store.search(request('replacementword')).results[0].id).toBe('reply')
      store.upsertToolCall({ id: 'tool', sessionId: 'a', messageSeq: 2, threadId: 'thread', title: 'Changed tool', status: 'completed', content: [{ type: 'text', text: 'newoutput' }] })
      expect(store.search(request('output')).results).toEqual([])
      expect(store.search(request('newoutput')).results[0].id).toBe('tool')
      expect(() => store.transaction(() => { store.updateMessageText('reply', 'rolledback'); throw new Error('rollback') })).toThrow()
      expect(store.search(request('rolledback')).results).toEqual([])
      store.deleteMessage('reply')
      expect(store.search(request('replacementword')).results).toEqual([])
      store.clearLog('a')
      expect(store.search(request('newoutput')).results).toEqual([])
      store.deleteSession('b')
      expect(store.search(request('cache')).results).toEqual([])
    } finally { store.close() }
  })

  it('backfills existing history on migration and preserves results after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-search-'))
    const path = join(dir, 'test.db')
    try {
      let store = new Store(path)
      seed(store)
      store.close()
      const db = new DatabaseSync(path)
      for (const name of ['message_search_insert', 'message_search_update', 'message_search_delete', 'tool_search_insert', 'tool_search_update', 'tool_search_delete']) db.exec(`DROP TRIGGER ${name}`)
      // Rewind the handoff migration too, so this really is a version-9 fixture.
      db.exec('ALTER TABLE sessions DROP COLUMN handoff')
      db.exec('DROP TABLE message_search; DROP TABLE tool_search; PRAGMA user_version = 9')
      db.close()
      store = new Store(path)
      expect(store.search(request('cache')).results).toHaveLength(4)
      store.close()
      store = new Store(path)
      expect(store.search(request('cache')).results).toHaveLength(4)
      store.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('bounds large result sets and finds a phrase in a substantial history within a second', () => {
    const store = new Store(':memory:')
    try {
      store.insertSession({ id: 's', cwd: '/work', agentId: 'claude', acpSessionId: 's', title: 'History', createdAt: 1 })
      store.transaction(() => {
        for (let i = 0; i < 10000; i++) store.insertMessage({ id: `m${i}`, sessionId: 's', seq: i, role: 'agent', text: `Message ${i}: general discussion about the code and cache. ${i === 4321 ? 'unique cache key format' : ''}`, threadId: null })
      })
      const start = performance.now()
      expect(store.search(request('"unique cache key format"')).results.map((r) => r.id)).toEqual(['m4321'])
      expect(performance.now() - start).toBeLessThan(1000)
      expect(store.search(request('cache'))).toMatchObject({ more: true, results: expect.any(Array) })
      expect(store.search(request('cache')).results).toHaveLength(100)
    } finally { store.close() }
  })
})
