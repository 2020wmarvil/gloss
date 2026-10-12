// Owns agent connections, session attachment, turns and sign-in.
// The agent sees one linear ACP session per Gloss session; the DB is the display state.
import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import type { GlossEvent, SessionView, TurnResult } from '../shared/ipc'
import type { AuthMethodInfo, Message, Session } from '../shared/types'
import { AgentConnection, isAuthRequired, type AgentHandlers } from './acp'
import type { AgentConfig } from './agents'
import type { Store } from './db'
import type { TerminalRunner } from './terminal'

export type SessionManagerDeps = {
  store: Store
  emit(event: GlossEvent): void
  getAgentConfig(agentId: string): AgentConfig
  /** Environment for the agent's processes (entrypoint and terminal sign-in). */
  agentEnv(config: AgentConfig): NodeJS.ProcessEnv
  /** Opens an initialized connection to the agent. */
  connect(config: AgentConfig, env: NodeJS.ProcessEnv, handlers: AgentHandlers): Promise<AgentConnection>
  runInTerminal: TerminalRunner
  now?(): number
}

type Turn = {
  threadId: string | null
  cancelled: boolean
  /** The agent message that text chunks currently append to. */
  agentMessage?: Message
  /** A tool call arrived since the last text; the next text starts a new message. */
  afterToolCall: boolean
}

type SessionRuntime = {
  /** The connection the session's ACP session is live on. */
  attachedTo?: AgentConnection
  /** session/load is replaying history; ignore its updates. */
  loading: boolean
  turn?: Turn
}

type SignIn = { promise: Promise<boolean>; resolve(ok: boolean): void }

type AgentSlot = {
  connection?: Promise<AgentConnection>
  /** The resolved connection, once `connection` has started. */
  current?: AgentConnection
  /** session/prompt requests in flight. */
  activePrompts: number
  /** Restart once the in-flight prompts finish. */
  restartPending?: boolean
  signIn?: SignIn
}

const TITLE_LENGTH = 60

export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in was cancelled.')
  }
}

export class SessionManager {
  private readonly runtimes = new Map<string, SessionRuntime>()
  /** ACP session id → Gloss session id. */
  private readonly byAcpId = new Map<string, string>()
  private readonly agents = new Map<string, AgentSlot>()
  private disposed = false

  constructor(private readonly deps: SessionManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private runtime(sessionId: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId)
    if (!rt) {
      rt = { loading: false }
      this.runtimes.set(sessionId, rt)
    }
    return rt
  }

  private slot(agentId: string): AgentSlot {
    let slot = this.agents.get(agentId)
    if (!slot) {
      slot = { activePrompts: 0 }
      this.agents.set(agentId, slot)
    }
    return slot
  }

  private session(id: string): Session {
    const s = this.deps.store.getSession(id)
    if (!s) throw new Error(`Unknown session ${id}`)
    return s
  }

  // Connections

  private connection(agentId: string): Promise<AgentConnection> {
    const slot = this.slot(agentId)
    if (!slot.connection) {
      const config = this.deps.getAgentConfig(agentId)
      const pending = this.deps.connect(config, this.deps.agentEnv(config), this.handlers(agentId))
      slot.connection = pending
      pending.then(
        (conn) => {
          if (slot.connection === pending) slot.current = conn
        },
        () => {
          if (slot.connection === pending) slot.connection = undefined
        }
      )
    }
    return slot.connection
  }

  private handlers(agentId: string): AgentHandlers {
    return {
      onUpdate: (n) => this.onUpdate(n),
      onPermission: (req) => this.onPermission(req),
      onStderr: (line) => console.error(`[${agentId}]`, line),
      onClosed: () => this.onClosed(agentId)
    }
  }

  private onClosed(agentId: string): void {
    const slot = this.slot(agentId)
    // Only forget the connection if it is the one that closed, not a newer one.
    if (slot.current?.isClosed) {
      slot.connection = undefined
      slot.current = undefined
    }
    this.detachClosed()
  }

  private detachClosed(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.attachedTo?.isClosed) rt.attachedTo = undefined
    }
  }

  /** Stops the agent's process if no prompt is in flight. The next request starts a fresh one. */
  async restartIdleAgent(agentId: string): Promise<boolean> {
    const slot = this.slot(agentId)
    if (!slot.connection || slot.activePrompts > 0) return false
    const pending = slot.connection
    slot.connection = undefined
    slot.current = undefined
    slot.restartPending = false
    try {
      ;(await pending).dispose()
    } catch {
      // It never started; nothing to stop.
    }
    this.detachClosed()
    return true
  }

  /** Restarts every agent (e.g. after a settings change), deferring busy ones until they are idle. */
  async restartAgents(): Promise<void> {
    await Promise.all(
      [...this.agents.entries()].map(async ([id, slot]) => {
        if (!(await this.restartIdleAgent(id)) && slot.connection) slot.restartPending = true
      })
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const pending = [...this.agents.values()].map((s) => s.connection)
    this.agents.clear()
    for (const p of pending) {
      try {
        ;(await p)?.dispose()
      } catch {
        // Never started.
      }
    }
  }

  // Sign-in (SPEC → Authentication)

  /**
   * Runs `op` against the agent's connection. If it fails with auth_required,
   * asks the user to sign in and retries.
   */
  private async withAgent<T>(agentId: string, op: (conn: AgentConnection) => Promise<T>): Promise<T> {
    for (;;) {
      const conn = await this.connection(agentId)
      try {
        return await op(conn)
      } catch (err) {
        if (!isAuthRequired(err) || conn.authMethods.length === 0) throw err
        const ok = await this.requestSignIn(agentId, conn)
        if (!ok) throw new SignInCancelledError()
      }
    }
  }

  private requestSignIn(agentId: string, conn: AgentConnection): Promise<boolean> {
    const slot = this.slot(agentId)
    if (!slot.signIn) {
      let resolve!: (ok: boolean) => void
      const promise = new Promise<boolean>((r) => (resolve = r))
      slot.signIn = { promise, resolve }
      this.deps.emit({
        type: 'authRequired',
        agentId,
        agentName: this.deps.getAgentConfig(agentId).name,
        methods: conn.authMethods.map(toAuthMethodInfo)
      })
    }
    return slot.signIn.promise
  }

  private settleSignIn(agentId: string, ok: boolean): void {
    const slot = this.slot(agentId)
    const pending = slot.signIn
    if (!pending) return
    slot.signIn = undefined
    pending.resolve(ok)
    this.deps.emit({ type: 'authResolved', agentId })
  }

  async signIn(agentId: string, methodId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const conn = await this.connection(agentId)
      const method = conn.authMethods.find((m) => m.id === methodId)
      if (!method) return { ok: false, error: `Unknown sign-in method ${methodId}` }

      if ('type' in method && method.type === 'terminal') {
        const config = this.deps.getAgentConfig(agentId)
        const env = { ...this.deps.agentEnv(config), ...method.env }
        const code = await this.deps.runInTerminal(config.command, [...config.args, ...(method.args ?? [])], env)
        if (code !== 0) {
          return { ok: false, error: `Sign-in did not finish (exit code ${code ?? 'unknown'}).` }
        }
        // The running agent may have cached its signed-out state.
        await this.restartIdleAgent(agentId)
      } else {
        await conn.authenticate(methodId)
      }
      this.settleSignIn(agentId, true)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  dismissSignIn(agentId: string): void {
    this.settleSignIn(agentId, false)
  }

  // Sessions

  listSessions(): Session[] {
    return this.deps.store.listSessions()
  }

  async createSession(cwd: string, agentId: string): Promise<Session> {
    let conn!: AgentConnection
    const res = await this.withAgent(agentId, async (c) => {
      conn = c
      return c.newSession(cwd)
    })
    const session: Session = {
      id: randomUUID(),
      agentId,
      acpSessionId: res.sessionId,
      cwd,
      title: folderName(cwd),
      createdAt: this.now()
    }
    this.deps.store.insertSession(session)
    this.byAcpId.set(session.acpSessionId, session.id)
    this.runtime(session.id).attachedTo = conn
    this.deps.emit({ type: 'session', session })
    return session
  }

  openSession(id: string): SessionView {
    const session = this.session(id)
    const turn = this.runtimes.get(id)?.turn
    return {
      session,
      messages: this.deps.store.listMessages(id),
      toolCalls: this.deps.store.listToolCalls(id),
      turn: turn ? { threadId: turn.threadId } : null
    }
  }

  /** Makes the session's ACP session live on `conn`: session/load, or a new session if that fails. */
  private async attach(sessionId: string, conn: AgentConnection): Promise<string> {
    const rt = this.runtime(sessionId)
    let session = this.session(sessionId)
    if (rt.attachedTo === conn) return session.acpSessionId

    if (conn.canLoadSession) {
      rt.loading = true
      this.byAcpId.set(session.acpSessionId, session.id)
      try {
        await conn.loadSession(session.acpSessionId, session.cwd)
        rt.attachedTo = conn
        return session.acpSessionId
      } catch (err) {
        if (isAuthRequired(err)) throw err
        console.error(`[gloss] session/load failed for ${sessionId}:`, errorMessage(err))
      } finally {
        rt.loading = false
      }
    }

    const res = await conn.newSession(session.cwd)
    this.byAcpId.delete(session.acpSessionId)
    session = this.deps.store.updateSession(session.id, { acpSessionId: res.sessionId })
    this.byAcpId.set(session.acpSessionId, session.id)
    rt.attachedTo = conn
    this.deps.emit({ type: 'session', session })
    this.deps.emit({
      type: 'notice',
      sessionId,
      text: 'Started a new agent session. The agent could not resume the previous one, so it does not remember the earlier messages shown here.'
    })
    return session.acpSessionId
  }

  // Turns

  async send(sessionId: string, text: string, threadId: string | null): Promise<TurnResult> {
    let session = this.session(sessionId)
    const rt = this.runtime(sessionId)
    if (rt.turn) throw new Error('A turn is already running in this session.')
    if (threadId !== null) throw new Error('Threads are not supported yet.')

    const wire = text
    const isFirst = this.deps.store.countUserMessages(sessionId) === 0
    const message: Message = {
      id: randomUUID(),
      sessionId,
      seq: this.deps.store.nextSeq(sessionId),
      role: 'user',
      text,
      wireText: wire,
      threadId
    }
    this.deps.store.insertMessage(message)
    this.deps.emit({ type: 'message', message })
    if (isFirst) {
      session = this.deps.store.updateSession(sessionId, { title: titleFrom(text) })
      this.deps.emit({ type: 'session', session })
    }

    const turn: Turn = { threadId, cancelled: false, afterToolCall: false }
    rt.turn = turn
    this.deps.emit({ type: 'turnStart', sessionId, threadId })

    let result: TurnResult
    try {
      const res = await this.withAgent(session.agentId, async (conn) => {
        // A retry after sign-in starts a fresh agent message.
        turn.agentMessage = undefined
        turn.afterToolCall = false
        const acpSessionId = await this.attach(sessionId, conn)
        if (turn.cancelled) return { stopReason: 'cancelled' as const }
        const slot = this.slot(session.agentId)
        slot.activePrompts++
        try {
          return await conn.prompt(acpSessionId, wire)
        } finally {
          slot.activePrompts--
          if (slot.restartPending && slot.activePrompts === 0) void this.restartIdleAgent(session.agentId)
        }
      })
      result = { stopReason: res.stopReason }
    } catch (err) {
      result = turn.cancelled ? { stopReason: 'cancelled' } : { error: errorMessage(err) }
    } finally {
      rt.turn = undefined
    }
    this.deps.emit({ type: 'turnEnd', sessionId, ...result })
    return result
  }

  async cancel(sessionId: string): Promise<void> {
    const rt = this.runtimes.get(sessionId)
    if (!rt?.turn) return
    rt.turn.cancelled = true
    const session = this.session(sessionId)
    // A turn waiting on sign-in stops waiting.
    this.settleSignIn(session.agentId, false)
    if (rt.attachedTo && !rt.loading) await rt.attachedTo.cancel(session.acpSessionId)
  }

  // Agent → client

  private onUpdate(n: acp.SessionNotification): void {
    const sessionId = this.byAcpId.get(n.sessionId)
    if (!sessionId || this.disposed) return
    const rt = this.runtimes.get(sessionId)
    // Updates outside a turn (including session/load's history replay) are not
    // part of the display state.
    if (!rt?.turn || rt.loading) return
    const turn = rt.turn
    const { store, emit } = this.deps
    const u = n.update

    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        if (u.content.type !== 'text') return
        const messageId = u.messageId ?? undefined
        let m = turn.agentMessage
        const differentMessage =
          messageId !== undefined && m?.acpMessageId !== undefined && m.acpMessageId !== messageId
        if (!m || turn.afterToolCall || differentMessage) {
          m = {
            id: randomUUID(),
            sessionId,
            seq: store.nextSeq(sessionId),
            role: 'agent',
            text: '',
            threadId: turn.threadId,
            ...(messageId !== undefined ? { acpMessageId: messageId } : {})
          }
          store.insertMessage(m)
          turn.agentMessage = m
          turn.afterToolCall = false
        }
        m.text += u.content.text
        store.updateMessageText(m.id, m.text)
        emit({ type: 'message', message: { ...m } })
        return
      }
      case 'tool_call': {
        const existing = store.getToolCall(sessionId, u.toolCallId)
        const toolCall = {
          id: u.toolCallId,
          sessionId,
          messageSeq: existing?.messageSeq ?? store.nextSeq(sessionId),
          threadId: existing?.threadId ?? turn.threadId,
          title: u.title,
          status: u.status ?? 'pending',
          ...(u.kind ? { kind: u.kind } : {}),
          ...(u.content ? { content: u.content } : {})
        }
        store.upsertToolCall(toolCall)
        turn.afterToolCall = true
        emit({ type: 'toolCall', toolCall })
        return
      }
      case 'tool_call_update': {
        const existing = store.getToolCall(sessionId, u.toolCallId)
        const toolCall = existing
          ? { ...existing }
          : {
              id: u.toolCallId,
              sessionId,
              messageSeq: store.nextSeq(sessionId),
              threadId: turn.threadId,
              title: 'Tool call',
              status: 'pending'
            }
        if (u.title != null) toolCall.title = u.title
        if (u.status != null) toolCall.status = u.status
        if (u.kind != null) toolCall.kind = u.kind
        if (u.content != null) toolCall.content = u.content
        store.upsertToolCall(toolCall)
        if (!existing) turn.afterToolCall = true
        emit({ type: 'toolCall', toolCall })
        return
      }
      default:
        // plan, thoughts, commands, usage, etc.: not shown in v1.
        return
    }
  }

  private async onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    // Approvals arrive in M5. Until then, decline and tell the user.
    const sessionId = this.byAcpId.get(req.sessionId)
    if (sessionId) {
      this.deps.emit({
        type: 'notice',
        sessionId,
        text: `Declined the agent's request to run "${req.toolCall.title ?? 'a tool'}". Approving tool calls is not supported yet.`
      })
    }
    const reject = req.options.find((o) => o.kind === 'reject_once')
    return reject
      ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }
}

function toAuthMethodInfo(m: acp.AuthMethod): AuthMethodInfo {
  return {
    id: m.id,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    kind: 'type' in m && m.type === 'terminal' ? 'terminal' : 'agent'
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line
}
