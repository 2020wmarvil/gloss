import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './db'
import type { Thread } from '../shared/types'

describe('Store', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it.each(['dev', 'review'] as const)('upgrades the %s version 11 schema without losing history', (branch) => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-db-'))
    dirs.push(dir)
    const path = join(dir, 'gloss.db')
    let store = new Store(path)
    store.insertSession({ id: 's', agentId: 'claude', acpSessionId: 'a', cwd: '/w', title: 'History', createdAt: 1 })
    store.insertMessage({ id: 'm', sessionId: 's', seq: 0, role: 'agent', text: 'original message', threadId: null })
    const thread: Thread = {
      id: 't', sessionId: 's', anchorMessageId: 'm',
      anchor: { kind: 'selection', start: 0, end: 8, text: 'original' }, createdAt: 2
    }
    store.insertThread(thread)
    const reviewThread: Thread = {
      id: 'r', sessionId: 's', anchorMessageId: null,
      anchor: { kind: 'line', file: 'app.ts', side: 'new', start: 1, end: 1, text: 'code', lines: ['code'] },
      finding: { severity: 'bug', title: 'Existing finding', body: 'Keep this finding' },
      resolvedAt: 3, createdAt: 2
    }
    if (branch === 'review') store.insertThread(reviewThread)
    store.close()

    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE sessions DROP COLUMN handoff')
    if (branch === 'dev') {
      db.exec(`
        ALTER TABLE sessions DROP COLUMN review_base;
        ALTER TABLE sessions ADD COLUMN handoff TEXT;
        UPDATE sessions SET handoff = 'existing handoff';
        CREATE TABLE legacy_threads (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          anchor_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          anchor TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO legacy_threads SELECT id, session_id, anchor_message_id, anchor, created_at FROM threads;
        DROP TABLE threads;
        ALTER TABLE legacy_threads RENAME TO threads;
        CREATE INDEX threads_by_session ON threads(session_id);
      `)
    }
    db.exec('ALTER TABLE sessions DROP COLUMN review_head; PRAGMA user_version = 11')
    db.close()

    store = new Store(path)
    try {
      expect(store.listSessions()).toHaveLength(1)
      expect(store.listMessages('s')[0].text).toBe('original message')
      expect(store.listThreads('s')).toEqual(branch === 'review' ? [thread, reviewThread] : [thread])
      if (branch === 'dev') store.insertThread(reviewThread)
      store.setThreadResolved('r', null)
      expect(store.getThread('r')).toEqual({ ...reviewThread, resolvedAt: undefined })
    } finally { store.close() }

    store = new Store(path)
    try {
      expect(store.listSessions()).toHaveLength(1)
      expect(store.listThreads('s')).toHaveLength(2)
      store.deleteMessage('m')
      expect(store.getThread('t')).toBeUndefined()
      expect(store.getThread('r')).toBeDefined()
    } finally { store.close() }
    const migrated = new DatabaseSync(path)
    try {
      expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 20 })
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      if (branch === 'dev') expect(migrated.prepare('SELECT handoff FROM sessions').get()).toMatchObject({ handoff: 'existing handoff' })
    } finally { migrated.close() }
  })

  it('removes saved Codex MCP startup reports and adjusts rewind prefixes without hiding actual tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-db-'))
    dirs.push(dir)
    const path = join(dir, 'gloss.db')
    let store = new Store(path)
    for (const agentId of ['codex', 'claude']) {
      store.insertSession({ id: agentId, agentId, acpSessionId: agentId, cwd: '/w', title: agentId, createdAt: 1 })
      store.insertMessage({ id: `${agentId}-prompt`, sessionId: agentId, seq: 0, role: 'user', text: 'hello', threadId: null })
      store.upsertToolCall({ id: 'mcp_startup.UnityMCP.old', sessionId: agentId, messageSeq: 1, threadId: null, title: 'mcp__UnityMCP__startup', status: 'failed' })
      store.upsertToolCall({ id: 'real-tool', sessionId: agentId, messageSeq: 2, threadId: null, title: 'mcp__UnityMCP__startup', status: 'failed' })
      store.rewindLog(agentId, 3, 3, null)
      // A report outside the retained prefix must not decrement the prefix count.
      store.upsertToolCall({ id: 'mcp_startup.UnityMCP.later', sessionId: agentId, messageSeq: 4, threadId: null, title: 'startup', status: 'failed' })
    }
    store.close()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 18')
    db.close()
    store = new Store(path)
    try {
      expect(store.listToolCalls('codex').map((t) => t.id)).toEqual(['real-tool'])
      expect(store.listToolCalls('claude')).toHaveLength(3)
      expect(store.rewindState('codex')?.prefixEntries).toBe(2)
      expect(store.rewindState('claude')?.prefixEntries).toBe(3)
      expect(store.listMessages('codex')[0].text).toBe('hello')
    } finally { store.close() }
    const migrated = new DatabaseSync(path)
    try {
      expect(migrated.prepare('SELECT count(*) AS n FROM tool_search').get()).toMatchObject({ n: 4 })
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { migrated.close() }
  })

  it('adds the permission columns to a version 15 database from the worktree branch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-db-'))
    dirs.push(dir)
    const path = join(dir, 'gloss.db')
    new Store(path).close()
    const db = new DatabaseSync(path)
    db.exec(`
      ALTER TABLE sessions DROP COLUMN mode;
      ALTER TABLE sessions DROP COLUMN auto_approve;
      ALTER TABLE sessions ADD COLUMN project_path TEXT;
      PRAGMA user_version = 15
    `)
    db.close()
    const store = new Store(path)
    try {
      store.insertSession({ id: 's', agentId: 'claude', acpSessionId: 'a', cwd: '/w', title: 'w', createdAt: 1 })
      expect(store.updateSession('s', { mode: 'plan', autoApprove: true })).toMatchObject({ mode: 'plan', autoApprove: true })
    } finally {
      store.close()
    }
  })

  it('keeps the range of a review session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-db-'))
    dirs.push(dir)
    const store = new Store(join(dir, 'gloss.db'))
    try {
      store.insertSession({ id: 'r', agentId: 'claude', acpSessionId: 'a', cwd: '/w', title: 'Review', createdAt: 1, review: { baseRef: 'origin/main' } })
      expect(store.getSession('r')?.review).toEqual({ baseRef: 'origin/main' })
      const sha = 'a'.repeat(40)
      expect(store.updateSession('r', { review: { baseRef: sha, headRef: 'HEAD' } }).review).toEqual({ baseRef: sha, headRef: 'HEAD' })
      expect(store.updateSession('r', { review: { baseRef: sha } }).review).toEqual({ baseRef: sha })
      store.insertSession({ id: 'd', agentId: 'claude', acpSessionId: 'b', cwd: '/w', title: 'Review', createdAt: 1, review: { baseRef: sha }, draft: true })
      expect(store.getSession('d')?.draft).toBe(true)
      expect(store.updateSession('d', { draft: false }).draft).toBeUndefined()
    } finally {
      store.close()
    }
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
