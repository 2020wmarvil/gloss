// SQLite persistence (node:sqlite). For agents that share their sessions, the log is a
// cache of the agent's own copy; threads and the rest are Gloss's own (SPEC → Shared sessions).
import { DatabaseSync } from 'node:sqlite'
import type { SearchRequest, SearchResponse, SearchResult } from '../shared/search'
import { sameFolder } from '../shared/paths'
import type { Anchor, Attachment, Finding, Message, Plan, PlanEntry, Session, Thread, ToolCall, TurnOutcome } from '../shared/types'

// Append-only. Each entry upgrades the schema by one version (PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    cwd            TEXT NOT NULL,
    title          TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    role           TEXT NOT NULL,
    text           TEXT NOT NULL,
    wire_text      TEXT,
    thread_id      TEXT,
    acp_message_id TEXT,
    UNIQUE (session_id, seq)
  );
  CREATE TABLE tool_calls (
    id          TEXT NOT NULL,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_seq INTEGER NOT NULL,
    thread_id   TEXT,
    title       TEXT NOT NULL,
    kind        TEXT,
    status      TEXT NOT NULL,
    content     TEXT,
    PRIMARY KEY (session_id, id)
  );
  `,
  `
  CREATE TABLE threads (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    anchor_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    anchor            TEXT NOT NULL,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX threads_by_session ON threads (session_id);
  `,
  `
  ALTER TABLE sessions ADD COLUMN model TEXT;
  ALTER TABLE messages ADD COLUMN attachments TEXT;
  CREATE TABLE projects (
    path     TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN steered INTEGER;
  `,
  `
  CREATE TABLE deleted_agent_sessions (
    agent_id       TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, acp_session_id)
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN created_at INTEGER;
  CREATE TABLE plans (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    thread_id  TEXT,
    entries    TEXT NOT NULL
  );
  CREATE INDEX plans_by_session ON plans (session_id);
  `,
  // Sessions made before shared sessions keep their titles: the agent's doesn't replace them.
  `
  ALTER TABLE sessions ADD COLUMN title_set INTEGER;
  ALTER TABLE sessions ADD COLUMN synced_at TEXT;
  UPDATE sessions SET title_set = 1;
  `,
  `
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  `,
  `
  ALTER TABLE messages ADD COLUMN outcome TEXT;
  `,
  `
  CREATE VIRTUAL TABLE message_search USING fts5(body, tokenize='unicode61');
  CREATE VIRTUAL TABLE tool_search USING fts5(body, tokenize='unicode61');
  INSERT INTO message_search(rowid, body) SELECT rowid, text FROM messages;
  INSERT INTO tool_search(rowid, body)
    SELECT t.rowid, t.title || char(10) || COALESCE((SELECT group_concat(value, char(10)) FROM json_tree(t.content) WHERE type = 'text' AND key IN ('text', 'oldText', 'newText', 'path', 'uri')), '') FROM tool_calls t;
  CREATE TRIGGER message_search_insert AFTER INSERT ON messages BEGIN
    INSERT INTO message_search(rowid, body) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER message_search_update AFTER UPDATE OF text ON messages BEGIN
    DELETE FROM message_search WHERE rowid = old.rowid;
    INSERT INTO message_search(rowid, body) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER message_search_delete AFTER DELETE ON messages BEGIN
    DELETE FROM message_search WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER tool_search_insert AFTER INSERT ON tool_calls BEGIN
    INSERT INTO tool_search(rowid, body) VALUES (new.rowid, new.title || char(10) || COALESCE((SELECT group_concat(value, char(10)) FROM json_tree(new.content) WHERE type = 'text' AND key IN ('text', 'oldText', 'newText', 'path', 'uri')), ''));
  END;
  CREATE TRIGGER tool_search_update AFTER UPDATE OF title, content ON tool_calls BEGIN
    DELETE FROM tool_search WHERE rowid = old.rowid;
    INSERT INTO tool_search(rowid, body) VALUES (new.rowid, new.title || char(10) || COALESCE((SELECT group_concat(value, char(10)) FROM json_tree(new.content) WHERE type = 'text' AND key IN ('text', 'oldText', 'newText', 'path', 'uri')), ''));
  END;
  CREATE TRIGGER tool_search_delete AFTER DELETE ON tool_calls BEGIN
    DELETE FROM tool_search WHERE rowid = old.rowid;
  END;
  `,
  // Review sessions: line anchors have no message, so the column becomes nullable (a rebuild in SQLite).
  `
  ALTER TABLE sessions ADD COLUMN review_base TEXT;
  CREATE TABLE threads_new (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    anchor_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    anchor            TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    finding           TEXT,
    resolved_at       INTEGER
  );
  INSERT INTO threads_new (id, session_id, anchor_message_id, anchor, created_at)
    SELECT id, session_id, anchor_message_id, anchor, created_at FROM threads ORDER BY rowid;
  DROP TABLE threads;
  ALTER TABLE threads_new RENAME TO threads;
  CREATE INDEX threads_by_session ON threads (session_id);
  `
]

type Row = Record<string, unknown>

function toSession(r: Row): Session {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    acpSessionId: r.acp_session_id as string,
    cwd: r.cwd as string,
    title: r.title as string,
    ...(r.title_set ? { titleSet: true as const } : {}),
    createdAt: Number(r.created_at),
    activeAt: r.active_at != null ? Number(r.active_at) : Number(r.created_at),
    ...(r.model != null ? { model: r.model as string } : {}),
    ...(r.effort != null ? { effort: r.effort as string } : {}),
    ...(r.synced_at != null ? { syncedAt: r.synced_at as string } : {}),
    ...(r.review_base != null ? { review: { baseRef: r.review_base as string }, openThreads: Number(r.open_threads) } : {})
  }
}

/** Sessions with the time of their newest message, and how many line threads are unresolved. */
const SESSIONS = `SELECT s.*,
  (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id) AS active_at,
  (SELECT COUNT(*) FROM threads t WHERE t.session_id = s.id AND t.resolved_at IS NULL AND t.anchor_message_id IS NULL) AS open_threads
  FROM sessions s`

function toMessage(r: Row): Message {
  const m: Message = {
    id: r.id as string,
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    role: r.role as Message['role'],
    text: r.text as string,
    threadId: (r.thread_id as string | null) ?? null
  }
  if (r.wire_text != null) m.wireText = r.wire_text as string
  if (r.acp_message_id != null) m.acpMessageId = r.acp_message_id as string
  if (r.attachments != null) m.attachments = JSON.parse(r.attachments as string) as Attachment[]
  if (r.steered) m.steered = true
  if (r.created_at != null) m.createdAt = Number(r.created_at)
  if (r.outcome != null) m.outcome = r.outcome as TurnOutcome
  return m
}

function toToolCall(r: Row): ToolCall {
  const t: ToolCall = {
    id: r.id as string,
    sessionId: r.session_id as string,
    messageSeq: Number(r.message_seq),
    threadId: (r.thread_id as string | null) ?? null,
    title: r.title as string,
    status: r.status as string
  }
  if (r.kind != null) t.kind = r.kind as string
  if (r.content != null) t.content = JSON.parse(r.content as string)
  return t
}

function toPlan(r: Row): Plan {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    threadId: (r.thread_id as string | null) ?? null,
    entries: JSON.parse(r.entries as string) as PlanEntry[]
  }
}

function toThread(r: Row): Thread {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    anchorMessageId: (r.anchor_message_id as string | null) ?? null,
    anchor: JSON.parse(r.anchor as string) as Anchor,
    ...(r.finding != null ? { finding: JSON.parse(r.finding as string) as Finding } : {}),
    ...(r.resolved_at != null ? { resolvedAt: Number(r.resolved_at) } : {}),
    createdAt: Number(r.created_at)
  }
}

export class Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  close(): void {
    this.db.close()
  }

  /** Runs `fn` in one transaction. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // Sessions

  /** Most recent activity first. */
  listSessions(): Session[] {
    return this.db
      .prepare(`${SESSIONS} ORDER BY COALESCE(active_at, s.created_at) DESC, s.created_at DESC`)
      .all()
      .map((r) => toSession(r as Row))
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare(`${SESSIONS} WHERE s.id = ?`).get(id)
    return r ? toSession(r as Row) : undefined
  }

  insertSession(s: Session): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, agent_id, acp_session_id, cwd, title, created_at, title_set, review_base) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(s.id, s.agentId, s.acpSessionId, s.cwd, s.title, s.createdAt, s.titleSet ? 1 : null, s.review?.baseRef ?? null)
  }

  getSessionByAcpId(agentId: string, acpSessionId: string): Session | undefined {
    const r = this.db
      .prepare(`${SESSIONS} WHERE s.agent_id = ? AND s.acp_session_id = ?`)
      .get(agentId, acpSessionId)
    return r ? toSession(r as Row) : undefined
  }

  /** Deletes the session with its messages, tool calls and threads. */
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** `syncedAt: null` forgets it. */
  updateSession(
    id: string,
    patch: Partial<Pick<Session, 'acpSessionId' | 'title' | 'titleSet' | 'model' | 'effort'>> & { syncedAt?: string | null }
  ): Session {
    if (patch.acpSessionId !== undefined) {
      this.db
        .prepare('UPDATE sessions SET acp_session_id = ? WHERE id = ?')
        .run(patch.acpSessionId, id)
    }
    if (patch.title !== undefined) {
      this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(patch.title, id)
    }
    if (patch.titleSet !== undefined) {
      this.db.prepare('UPDATE sessions SET title_set = ? WHERE id = ?').run(patch.titleSet ? 1 : null, id)
    }
    if (patch.model !== undefined) {
      this.db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(patch.model, id)
    }
    if (patch.effort !== undefined) {
      this.db.prepare('UPDATE sessions SET effort = ? WHERE id = ?').run(patch.effort, id)
    }
    if (patch.syncedAt !== undefined) {
      this.db.prepare('UPDATE sessions SET synced_at = ? WHERE id = ?').run(patch.syncedAt, id)
    }
    const s = this.getSession(id)
    if (!s) throw new Error(`No session ${id}`)
    return s
  }

  /** Next position in the session's log. Messages, tool calls and plans share one sequence. */
  nextSeq(sessionId: string): number {
    const r = this.db
      .prepare(
        `SELECT MAX(s) AS m FROM (
           SELECT seq AS s FROM messages WHERE session_id = ?
           UNION ALL
           SELECT message_seq AS s FROM tool_calls WHERE session_id = ?
           UNION ALL
           SELECT seq AS s FROM plans WHERE session_id = ?)`
      )
      .get(sessionId, sessionId, sessionId) as { m: number | null }
    return r.m == null ? 0 : Number(r.m) + 1
  }

  /** Literal words (AND), or a phrase in double quotes. User input is never FTS syntax. */
  search(request: SearchRequest): SearchResponse {
    if (!request || typeof request.query !== 'string' || request.query.length > 1000 ||
        !['session', 'project', 'all'].includes(request.scope) ||
        !['all', 'user', 'agent', 'tool'].includes(request.kind)) throw new Error('Invalid search')
    if (request.scope === 'session' && typeof request.sessionId !== 'string') throw new Error('Search needs a session')
    if (request.scope === 'project' && (typeof request.cwd !== 'string' || !request.cwd.trim())) throw new Error('Search needs a project')
    const terms = (request.query.match(/"[^"]+"|[^\s"]+/gu) ?? []).filter((term) => /[\p{L}\p{N}]/u.test(term))
    const query = terms.map((term) => '"' + term.replace(/^"|"$/g, '').replace(/"/g, '""') + '"').join(' AND ')
    if (!query || !/[\p{L}\p{N}]/u.test(query)) return { results: [], more: false }
    const sessionIds = request.scope === 'session' ? [request.sessionId!] : request.scope === 'project'
      ? (this.db.prepare('SELECT id, cwd FROM sessions').all() as { id: string; cwd: string }[])
        .filter((s) => sameFolder(s.cwd, request.cwd!)).map((s) => s.id)
      : null
    if (sessionIds?.length === 0) return { results: [], more: false }
    const scopeSql = (alias: string): string => sessionIds ? ` AND ${alias}.session_id IN (${sessionIds.map(() => '?').join(',')})` : ''
    const parts: string[] = []
    const args: string[] = []
    if (request.kind !== 'tool') {
      parts.push(`SELECT m.id, m.session_id, m.thread_id, m.role AS kind,
        snippet(message_search, 0, char(1), char(2), '...', 32) AS snippet, rank AS score
        FROM message_search JOIN messages m ON m.rowid = message_search.rowid
        WHERE message_search MATCH ? ${scopeSql('m')}
        ${request.kind === 'all' ? '' : 'AND m.role = ?'}`)
      args.push(query, ...(sessionIds ?? []))
      if (request.kind !== 'all') args.push(request.kind)
    }
    if (request.kind === 'all' || request.kind === 'tool') {
      parts.push(`SELECT t.id, t.session_id, t.thread_id, 'tool' AS kind,
        snippet(tool_search, 0, char(1), char(2), '...', 32) AS snippet, rank AS score
        FROM tool_search JOIN tool_calls t ON t.rowid = tool_search.rowid
        WHERE tool_search MATCH ? ${scopeSql('t')}`)
      args.push(query, ...(sessionIds ?? []))
    }
    const rows = this.db.prepare(`SELECT r.*, s.title, s.cwd, th.anchor FROM (${parts.join(' UNION ALL ')}) r
      JOIN sessions s ON s.id = r.session_id LEFT JOIN threads th ON th.id = r.thread_id
      ORDER BY r.score, s.created_at DESC, r.id LIMIT 101`).all(...args) as Row[]
    const results: SearchResult[] = rows.slice(0, 100).map((r) => ({
      id: r.id as string, sessionId: r.session_id as string, sessionTitle: r.title as string,
      cwd: r.cwd as string, threadId: r.thread_id as string | null,
      threadQuote: r.anchor ? (JSON.parse(r.anchor as string) as Anchor).text : null,
      kind: r.kind as SearchResult['kind'], snippet: r.snippet as string
    }))
    return { results, more: rows.length > 100 }
  }

  // Messages

  insertMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, text, wire_text, thread_id, acp_message_id, attachments, steered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.sessionId,
        m.seq,
        m.role,
        m.text,
        m.wireText ?? null,
        m.threadId,
        m.acpMessageId ?? null,
        m.attachments ? JSON.stringify(m.attachments) : null,
        m.steered ? 1 : null,
        m.createdAt ?? null
      )
  }

  deleteMessage(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  updateMessageText(id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, id)
  }

  setMessageOutcome(id: string, outcome: TurnOutcome): void {
    this.db.prepare('UPDATE messages SET outcome = ? WHERE id = ?').run(outcome, id)
  }

  /**
   * Gives the session's log the order of `entries` (seq 0, 1, …). Every message
   * of the session must be in it. Entries not stored yet are inserted by `insert`
   * once their seq is free.
   */
  resequence(
    sessionId: string,
    entries: ({ kind: 'message' | 'toolCall' | 'plan'; id: string } | { insert(seq: number): void })[]
  ): void {
    // Out of the way first: messages' seqs are unique.
    this.db.prepare('UPDATE messages SET seq = -1 - seq WHERE session_id = ?').run(sessionId)
    const message = this.db.prepare('UPDATE messages SET seq = ? WHERE id = ?')
    const toolCall = this.db.prepare('UPDATE tool_calls SET message_seq = ? WHERE session_id = ? AND id = ?')
    const plan = this.db.prepare('UPDATE plans SET seq = ? WHERE id = ?')
    entries.forEach((e, seq) => {
      if ('insert' in e) e.insert(seq)
      else if (e.kind === 'message') message.run(seq, e.id)
      else if (e.kind === 'toolCall') toolCall.run(seq, sessionId, e.id)
      else plan.run(seq, e.id)
    })
  }

  /** Removes the session's messages, tool calls, plans and threads (to rebuild them). */
  clearLog(sessionId: string): void {
    this.db.prepare('DELETE FROM plans WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM threads WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(sessionId)
  }

  listMessages(sessionId: string): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId)
      .map((r) => toMessage(r as Row))
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return r ? toMessage(r as Row) : undefined
  }

  /**
   * The text of the user's messages in every session, newest first, each once (at its
   * latest use): the composers' history (SPEC → Composer → History).
   */
  messageHistory(limit = 500): string[] {
    const rows = this.db
      .prepare(
        "SELECT text FROM messages WHERE role = 'user' AND text <> '' GROUP BY text ORDER BY MAX(COALESCE(created_at, 0)) DESC, MAX(rowid) DESC LIMIT ?"
      )
      .all(limit) as { text: string }[]
    return rows.map((r) => r.text)
  }

  /** The session's latest user message. */
  lastUserMessage(sessionId: string): Message | undefined {
    const r = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1")
      .get(sessionId)
    return r ? toMessage(r as Row) : undefined
  }

  countUserMessages(sessionId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'")
      .get(sessionId) as { n: number }
    return Number(r.n)
  }

  // Tool calls

  getToolCall(sessionId: string, id: string): ToolCall | undefined {
    const r = this.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? AND id = ?')
      .get(sessionId, id)
    return r ? toToolCall(r as Row) : undefined
  }

  upsertToolCall(t: ToolCall): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, session_id, message_seq, thread_id, title, kind, status, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, id) DO UPDATE SET
           title = excluded.title, kind = excluded.kind,
           status = excluded.status, content = excluded.content`
      )
      .run(
        t.id,
        t.sessionId,
        t.messageSeq,
        t.threadId,
        t.title,
        t.kind ?? null,
        t.status,
        t.content === undefined ? null : JSON.stringify(t.content)
      )
  }

  deleteToolCall(sessionId: string, id: string): void {
    this.db.prepare('DELETE FROM tool_calls WHERE session_id = ? AND id = ?').run(sessionId, id)
  }

  listToolCalls(sessionId: string): ToolCall[] {
    return this.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY message_seq')
      .all(sessionId)
      .map((r) => toToolCall(r as Row))
  }

  // Plans

  upsertPlan(p: Plan): void {
    this.db
      .prepare(
        `INSERT INTO plans (id, session_id, seq, thread_id, entries) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET entries = excluded.entries`
      )
      .run(p.id, p.sessionId, p.seq, p.threadId, JSON.stringify(p.entries))
  }

  listPlans(sessionId: string): Plan[] {
    return this.db
      .prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY seq')
      .all(sessionId)
      .map((r) => toPlan(r as Row))
  }

  // Agent sessions Gloss deleted (session/delete), in case the agent lists them again

  addDeletedAgentSession(agentId: string, acpSessionId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO deleted_agent_sessions (agent_id, acp_session_id) VALUES (?, ?)')
      .run(agentId, acpSessionId)
  }

  listDeletedAgentSessions(agentId: string): string[] {
    return this.db
      .prepare('SELECT acp_session_id FROM deleted_agent_sessions WHERE agent_id = ?')
      .all(agentId)
      .map((r) => (r as Row).acp_session_id as string)
  }

  // Projects (folders opened in Gloss; folders of sessions count too)

  addProject(path: string, addedAt: number): void {
    this.db.prepare('INSERT OR IGNORE INTO projects (path, added_at) VALUES (?, ?)').run(path, addedAt)
  }

  removeProject(path: string): void {
    this.db.prepare('DELETE FROM projects WHERE path = ?').run(path)
  }

  listProjects(): { path: string; addedAt: number }[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY added_at DESC')
      .all()
      .map((r) => ({ path: (r as Row).path as string, addedAt: Number((r as Row).added_at) }))
  }

  // Threads

  insertThread(t: Thread): void {
    this.db
      .prepare(
        'INSERT INTO threads (id, session_id, anchor_message_id, anchor, created_at, finding, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        t.id,
        t.sessionId,
        t.anchorMessageId,
        JSON.stringify(t.anchor),
        t.createdAt,
        t.finding ? JSON.stringify(t.finding) : null,
        t.resolvedAt ?? null
      )
  }

  /** Resolves a review thread (`at`), or reopens it (null). */
  setThreadResolved(id: string, at: number | null): void {
    this.db.prepare('UPDATE threads SET resolved_at = ? WHERE id = ?').run(at, id)
  }

  getThread(id: string): Thread | undefined {
    const r = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id)
    return r ? toThread(r as Row) : undefined
  }

  listThreads(sessionId: string): Thread[] {
    return this.db
      .prepare('SELECT * FROM threads WHERE session_id = ? ORDER BY created_at, rowid')
      .all(sessionId)
      .map((r) => toThread(r as Row))
  }
}
