// SQLite persistence (node:sqlite). The app's DB is always the display state.
import { DatabaseSync } from 'node:sqlite'
import type { Message, Session, ToolCall } from '../shared/types'

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
    createdAt: Number(r.created_at)
  }
}

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

  // Sessions

  listSessions(): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC')
      .all()
      .map((r) => toSession(r as Row))
  }

  getSession(id: string): Session | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return r ? toSession(r as Row) : undefined
  }

  insertSession(s: Session): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, agent_id, acp_session_id, cwd, title, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(s.id, s.agentId, s.acpSessionId, s.cwd, s.title, s.createdAt)
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'acpSessionId' | 'title'>>): Session {
    if (patch.acpSessionId !== undefined) {
      this.db
        .prepare('UPDATE sessions SET acp_session_id = ? WHERE id = ?')
        .run(patch.acpSessionId, id)
    }
    if (patch.title !== undefined) {
      this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(patch.title, id)
    }
    const s = this.getSession(id)
    if (!s) throw new Error(`No session ${id}`)
    return s
  }

  /** Next position in the session's log. Messages and tool calls share one sequence. */
  nextSeq(sessionId: string): number {
    const r = this.db
      .prepare(
        `SELECT MAX(s) AS m FROM (
           SELECT seq AS s FROM messages WHERE session_id = ?
           UNION ALL
           SELECT message_seq AS s FROM tool_calls WHERE session_id = ?)`
      )
      .get(sessionId, sessionId) as { m: number | null }
    return r.m == null ? 0 : Number(r.m) + 1
  }

  // Messages

  insertMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, text, wire_text, thread_id, acp_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.sessionId,
        m.seq,
        m.role,
        m.text,
        m.wireText ?? null,
        m.threadId,
        m.acpMessageId ?? null
      )
  }

  updateMessageText(id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, id)
  }

  listMessages(sessionId: string): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId)
      .map((r) => toMessage(r as Row))
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

  listToolCalls(sessionId: string): ToolCall[] {
    return this.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY message_seq')
      .all(sessionId)
      .map((r) => toToolCall(r as Row))
  }
}
