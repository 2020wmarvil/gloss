// Owns agent connections, session attachment, turns and sign-in.
// The agent sees one linear ACP session per Gloss session; the DB is the display state.
import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import { pathToFileURL } from 'node:url'
import type { GlossEvent, SessionView, TurnResult } from '../shared/ipc'
import type {
  AgentSession,
  Anchor,
  Attachment,
  AuthMethodInfo,
  Message,
  Project,
  RateLimit,
  Session,
  SessionLive,
  Thread
} from '../shared/types'
import { wireText } from '../shared/wire'
import { AgentConnection, isAuthRequired, type AgentHandlers } from './acp'
import type { AgentConfig } from './agents'
import type { Store } from './db'
import { samePath } from './settings'
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
  /** The dev model (Haiku) is on: it overrides the model picked per session. */
  devModel?(): boolean
  now?(): number
}

/** Where the agent's updates are being written: a turn, or an import's history replay. */
type Recorder = {
  threadId: string | null
  /** The agent message that text chunks currently append to. */
  agentMessage?: Message
  /** Import only: the user message that user chunks append to. */
  userMessage?: Message
  /** A tool call arrived since the last text; the next text starts a new message. */
  afterToolCall: boolean
}

type Turn = Recorder & { cancelled: boolean }

type SessionRuntime = {
  /** The connection the session's ACP session is live on. */
  attachedTo?: AgentConnection
  /** An attach in progress, so concurrent callers share it. */
  attaching?: { conn: AgentConnection; promise: Promise<string> }
  /** session/load is replaying history; ignore its updates unless importing. */
  loading: boolean
  /** The session is being imported: session/load's replay becomes its history. */
  importing?: Recorder
  turn?: Turn
  live: SessionLive
}

function emptyLive(): SessionLive {
  return {
    attached: false,
    model: null,
    commands: [],
    usage: null,
    rateLimits: [],
    permissions: null,
    accepts: { image: false, file: false }
  }
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
  /** Session state the agent reported for an ACP session before Gloss registered it (during session/new). */
  private readonly pendingLive = new Map<string, Partial<SessionLive>>()
  private readonly agents = new Map<string, AgentSlot>()
  private disposed = false

  constructor(private readonly deps: SessionManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private runtime(sessionId: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId)
    if (!rt) {
      rt = { loading: false, live: emptyLive() }
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
    for (const [id, rt] of this.runtimes) {
      if (rt.attachedTo?.isClosed) {
        rt.attachedTo = undefined
        this.setLive(id, { attached: false })
      }
    }
  }

  /** Maps an ACP session to its Gloss session, applying anything the agent reported before. */
  private register(acpSessionId: string, sessionId: string): void {
    this.byAcpId.set(acpSessionId, sessionId)
    const pending = this.pendingLive.get(acpSessionId)
    if (pending) {
      this.pendingLive.delete(acpSessionId)
      this.setLive(sessionId, pending)
    }
  }

  private setLive(sessionId: string, patch: Partial<SessionLive>): void {
    const rt = this.runtime(sessionId)
    rt.live = { ...rt.live, ...patch }
    this.deps.emit({ type: 'live', sessionId, live: rt.live })
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
    let permissions: SessionLive['permissions'] = null
    const res = await this.withAgent(agentId, async (c) => {
      conn = c
      const created = await c.newSession(cwd)
      permissions = await this.enterBypassMode(agentId, c, created.sessionId, created.modes)
      return created
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
    this.deps.store.addProject(cwd, this.now())
    this.register(session.acpSessionId, session.id)
    this.runtime(session.id).attachedTo = conn
    this.deps.emit({ type: 'session', session })
    await this.attached(session.id, conn, res.configOptions, permissions)
    return session
  }

  /** Imports one of the agent's sessions: a Gloss session whose main thread is built from the session/load replay. */
  async importSession(cwd: string, agentId: string, acpSessionId: string, title: string): Promise<Session> {
    const existing = this.deps.store.getSessionByAcpId(agentId, acpSessionId)
    if (existing) return existing
    const session: Session = {
      id: randomUUID(),
      agentId,
      acpSessionId,
      cwd,
      title: title.trim() || folderName(cwd),
      createdAt: this.now()
    }
    const { store } = this.deps
    store.insertSession(session)
    this.byAcpId.set(acpSessionId, session.id)
    const rt = this.runtime(session.id)
    try {
      await this.withAgent(agentId, async (conn) => {
        if (!conn.canLoadSession) {
          throw new Error(
            `${this.deps.getAgentConfig(agentId).name} can't resume its sessions, so they can't be opened here.`
          )
        }
        // A retry after sign-in replays from the start.
        store.clearLog(session.id)
        rt.importing = { threadId: null, afterToolCall: false }
        await this.attach(session.id, conn)
      })
    } catch (err) {
      store.deleteSession(session.id)
      this.runtimes.delete(session.id)
      this.byAcpId.delete(acpSessionId)
      throw err
    } finally {
      rt.importing = undefined
    }
    store.addProject(cwd, this.now())
    this.deps.emit({ type: 'session', session })
    return session
  }

  openSession(id: string): SessionView {
    const session = this.session(id)
    const rt = this.runtime(id)
    if (!rt.attachedTo) void this.resume(id)
    return {
      session,
      messages: this.deps.store.listMessages(id),
      toolCalls: this.deps.store.listToolCalls(id),
      threads: this.deps.store.listThreads(id),
      turn: rt.turn ? { threadId: rt.turn.threadId } : null,
      live: rt.live
    }
  }

  /** Resumes the session on the agent so the status line has its model, commands and usage. */
  private async resume(id: string): Promise<void> {
    const session = this.session(id)
    try {
      await this.withAgent(session.agentId, (conn) => this.attach(id, conn))
    } catch (err) {
      if (err instanceof SignInCancelledError || !this.deps.store.getSession(id)) return
      this.notice(id, null, `Couldn't resume the session on the agent: ${errorMessage(err)}`)
    }
  }

  renameSession(id: string, title: string): Session {
    this.session(id)
    const trimmed = title.replace(/\s+/g, ' ').trim()
    if (!trimmed) throw new Error('A session needs a title.')
    const session = this.deps.store.updateSession(id, { title: trimmed.slice(0, 200) })
    this.deps.emit({ type: 'session', session })
    return session
  }

  /**
   * Deletes the session from the DB and the agent's own copy (session/delete,
   * when advertised). Returns a warning if the agent's copy couldn't be deleted.
   */
  async deleteSession(id: string): Promise<string | null> {
    const session = this.session(id)
    const rt = this.runtime(id)
    if (rt.turn) await this.cancel(id)
    let warning: string | null = null
    try {
      await this.withAgent(session.agentId, async (conn) => {
        if (conn.canDeleteSessions) await conn.deleteSession(session.acpSessionId)
      })
    } catch (err) {
      // A session that never had a message may have no copy on the agent's side
      // (Claude Code writes its transcript on the first prompt): nothing was lost.
      if (this.deps.store.countUserMessages(id) > 0) {
        warning = `Deleted from Gloss, but the agent couldn't delete its own copy: ${errorMessage(err)}`
      }
    }
    this.deps.store.deleteSession(id)
    this.runtimes.delete(id)
    this.byAcpId.delete(session.acpSessionId)
    this.deps.emit({ type: 'sessionDeleted', sessionId: id })
    return warning
  }

  /** Picks the session's model via the agent's model config option. */
  async setModel(id: string, value: string): Promise<void> {
    const session = this.session(id)
    if (this.deps.devModel?.()) throw new Error('The dev model is on. Turn it off in Settings to pick a model.')
    await this.withAgent(session.agentId, async (conn) => {
      const acpSessionId = await this.attach(id, conn)
      const model = this.runtime(id).live.model
      if (!model) throw new Error("The agent doesn't offer a choice of model.")
      const res = await conn.setConfigOption(acpSessionId, model.configId, value)
      this.setLive(id, { model: modelOption(res.configOptions) })
    })
    const updated = this.deps.store.updateSession(id, { model: value })
    this.deps.emit({ type: 'session', session: updated })
  }

  // Projects

  /** Folders opened in Gloss and folders of its sessions, most recent first. */
  listProjects(): Project[] {
    const dated = [
      ...this.deps.store.listSessions().map((s) => ({ path: s.cwd, at: s.createdAt })),
      ...this.deps.store.listProjects().map((p) => ({ path: p.path, at: p.addedAt }))
    ].sort((a, b) => b.at - a.at)
    const projects: Project[] = []
    for (const { path } of dated) {
      if (!projects.some((p) => samePath(p.path, path))) projects.push({ path, name: folderName(path) })
    }
    return projects
  }

  addProject(path: string): Project {
    const known = this.listProjects().find((p) => samePath(p.path, path))
    this.deps.store.addProject(known?.path ?? path, this.now())
    return known ?? { path, name: folderName(path) }
  }

  /**
   * Deletes a project: each of its Gloss sessions as deleteSession does (the
   * agent's copy too), then the project itself. The agent's sessions Gloss never
   * imported are left alone. Returns warnings for agent copies that couldn't be deleted.
   */
  async deleteProject(path: string): Promise<string | null> {
    const warnings: string[] = []
    for (const s of this.deps.store.listSessions()) {
      if (!samePath(s.cwd, path)) continue
      const warning = await this.deleteSession(s.id)
      if (warning) warnings.push(`${s.title}: ${warning}`)
    }
    for (const p of this.deps.store.listProjects()) {
      if (samePath(p.path, path)) this.deps.store.removeProject(p.path)
    }
    return warnings.length > 0 ? warnings.join('\n') : null
  }

  /** The agent's sessions in `cwd` that Gloss hasn't imported (session/list, when advertised). */
  async agentSessions(cwd: string, agentId: string): Promise<AgentSession[]> {
    const listed = await this.withAgent(agentId, (conn) =>
      conn.canListSessions ? conn.listSessions(cwd) : Promise.resolve([])
    )
    const known = new Set(
      this.deps.store
        .listSessions()
        .filter((s) => s.agentId === agentId)
        .map((s) => s.acpSessionId)
    )
    return listed
      .filter((s) => !known.has(s.sessionId))
      .map((s) => ({
        acpSessionId: s.sessionId,
        title: s.title?.trim() || 'Untitled session',
        ...(s.updatedAt ? { updatedAt: s.updatedAt } : {})
      }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  // Threads

  createThread(sessionId: string, anchorMessageId: string, anchor: Anchor): Thread {
    this.session(sessionId)
    const message = this.deps.store.getMessage(anchorMessageId)
    if (!message || message.sessionId !== sessionId || message.role !== 'agent') {
      throw new Error('Threads can only be anchored to an agent message in this session.')
    }
    const valid =
      anchor.kind === 'listItem'
        ? anchor.path.length > 0 && anchor.path.every((i) => Number.isInteger(i) && i >= 0)
        : Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start < anchor.end
    if (!valid || typeof anchor.text !== 'string' || anchor.text.trim() === '') {
      throw new Error('Invalid thread anchor.')
    }
    const existing = this.deps.store
      .listThreads(sessionId)
      .find((t) => t.anchorMessageId === anchorMessageId && sameAnchor(t.anchor, anchor))
    if (existing) return existing

    const thread: Thread = {
      id: randomUUID(),
      sessionId,
      anchorMessageId,
      anchor: normalizeAnchor(anchor),
      createdAt: this.now()
    }
    this.deps.store.insertThread(thread)
    this.deps.emit({ type: 'thread', thread })
    return thread
  }

  private notice(sessionId: string, threadId: string | null, text: string): void {
    this.deps.emit({ type: 'notice', sessionId, threadId, text })
  }

  /** Makes the session's ACP session live on `conn`. Concurrent callers share one attach. */
  private attach(sessionId: string, conn: AgentConnection): Promise<string> {
    const rt = this.runtime(sessionId)
    if (rt.attachedTo === conn) return Promise.resolve(this.session(sessionId).acpSessionId)
    if (rt.attaching?.conn === conn) return rt.attaching.promise
    const promise = this.doAttach(sessionId, conn).finally(() => {
      if (rt.attaching?.promise === promise) rt.attaching = undefined
    })
    rt.attaching = { conn, promise }
    return promise
  }

  /** session/load, or a new session if that fails (except when importing). */
  private async doAttach(sessionId: string, conn: AgentConnection): Promise<string> {
    const rt = this.runtime(sessionId)
    let session = this.session(sessionId)

    if (conn.canLoadSession) {
      rt.loading = true
      this.byAcpId.set(session.acpSessionId, session.id)
      let loaded: acp.LoadSessionResponse | undefined
      try {
        loaded = await conn.loadSession(session.acpSessionId, session.cwd)
      } catch (err) {
        if (isAuthRequired(err) || rt.importing) throw err
        console.error(`[gloss] session/load failed for ${sessionId}:`, errorMessage(err))
      } finally {
        rt.loading = false
      }
      if (loaded) {
        const permissions = await this.enterBypassMode(session.agentId, conn, session.acpSessionId, loaded.modes)
        rt.attachedTo = conn
        await this.attached(sessionId, conn, loaded.configOptions, permissions)
        return session.acpSessionId
      }
    }

    const res = await conn.newSession(session.cwd)
    const permissions = await this.enterBypassMode(session.agentId, conn, res.sessionId, res.modes)
    this.byAcpId.delete(session.acpSessionId)
    session = this.deps.store.updateSession(session.id, { acpSessionId: res.sessionId })
    this.register(session.acpSessionId, session.id)
    rt.attachedTo = conn
    this.deps.emit({ type: 'session', session })
    await this.attached(sessionId, conn, res.configOptions, permissions)
    this.notice(
      sessionId,
      rt.turn?.threadId ?? null,
      'Started a new agent session. The agent could not resume the previous one, so it does not remember the earlier messages shown here.'
    )
    return session.acpSessionId
  }

  /**
   * Switches an ACP session to the agent's bypass-permissions mode when the
   * agent offers it. Best effort: permission requests are auto-approved anyway.
   */
  private async enterBypassMode(
    agentId: string,
    conn: AgentConnection,
    acpSessionId: string,
    modes: acp.SessionModeState | null | undefined
  ): Promise<SessionLive['permissions']> {
    const modeId = this.deps.getAgentConfig(agentId).bypassModeId
    if (!modeId || !modes) return 'auto'
    if (modes.currentModeId === modeId) return 'bypass'
    if (!modes.availableModes.some((m) => m.id === modeId)) {
      console.warn(`[gloss] ${agentId} does not offer mode "${modeId}" here; auto-approving permission requests instead.`)
      return 'auto'
    }
    try {
      await conn.setMode(acpSessionId, modeId)
      return 'bypass'
    } catch (err) {
      console.warn(`[gloss] could not switch to mode "${modeId}":`, errorMessage(err))
      return 'auto'
    }
  }

  /** Records what the agent reported on attach, and re-applies the session's model. */
  private async attached(
    sessionId: string,
    conn: AgentConnection,
    configOptions: acp.SessionConfigOption[] | null | undefined,
    permissions: SessionLive['permissions']
  ): Promise<void> {
    const caps = conn.promptCapabilities
    let model = modelOption(configOptions ?? [])
    const session = this.session(sessionId)
    const wanted = session.model
    if (
      wanted &&
      model &&
      model.current !== wanted &&
      !this.deps.devModel?.() &&
      model.options.some((o) => o.value === wanted)
    ) {
      try {
        const res = await conn.setConfigOption(session.acpSessionId, model.configId, wanted)
        model = modelOption(res.configOptions)
      } catch (err) {
        console.warn(`[gloss] could not set the model to "${wanted}":`, errorMessage(err))
      }
    }
    this.setLive(sessionId, {
      attached: true,
      model,
      permissions,
      accepts: { image: caps.image === true, file: caps.embeddedContext === true }
    })
  }

  // Turns

  async send(
    sessionId: string,
    text: string,
    threadId: string | null,
    attachments: Attachment[] = []
  ): Promise<TurnResult> {
    let session = this.session(sessionId)
    const rt = this.runtime(sessionId)
    if (rt.turn) throw new Error('A turn is already running in this session.')
    let anchorText: string | null = null
    if (threadId !== null) {
      const thread = this.deps.store.getThread(threadId)
      if (!thread || thread.sessionId !== sessionId) throw new Error(`Unknown thread ${threadId}`)
      anchorText = thread.anchor.text
    }

    const wire = wireText(text, anchorText)
    const isFirst = this.deps.store.countUserMessages(sessionId) === 0
    const message: Message = {
      id: randomUUID(),
      sessionId,
      seq: this.deps.store.nextSeq(sessionId),
      role: 'user',
      text,
      wireText: wire,
      threadId,
      ...(attachments.length > 0 ? { attachments } : {})
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
        const prompt = promptBlocks(wire, attachments, conn.promptCapabilities)
        const slot = this.slot(session.agentId)
        slot.activePrompts++
        try {
          return await conn.prompt(acpSessionId, prompt)
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
    this.deps.emit({ type: 'turnEnd', sessionId, threadId, ...result })
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
    if (this.disposed) return
    const u = n.update
    const sessionId = this.byAcpId.get(n.sessionId)

    // What the agent reports about the session, at any time.
    const pending = this.pendingLive.get(n.sessionId)
    const current = sessionId ? this.runtime(sessionId).live.rateLimits : (pending?.rateLimits ?? [])
    const live = liveUpdate(u, current)
    if (live) {
      if (sessionId) this.setLive(sessionId, live)
      else this.pendingLive.set(n.sessionId, { ...pending, ...live })
      return
    }
    if (!sessionId) return
    const rt = this.runtimes.get(sessionId)
    if (!rt) return

    switch (u.sessionUpdate) {
      case 'current_mode_update': {
        const session = this.deps.store.getSession(sessionId)
        const bypass = session && this.deps.getAgentConfig(session.agentId).bypassModeId
        if (bypass) this.setLive(sessionId, { permissions: u.currentModeId === bypass ? 'bypass' : 'auto' })
        return
      }
    }

    // Conversation updates are recorded during a turn, and during session/load
    // only when importing. Otherwise the replay is not part of the display state.
    const turn = rt.loading ? rt.importing : rt.turn
    if (!turn) return
    const { store, emit } = this.deps

    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        if (!rt.importing) return
        const messageId = u.messageId ?? undefined
        let m = turn.userMessage
        const differentMessage =
          messageId !== undefined && m?.acpMessageId !== undefined && m.acpMessageId !== messageId
        if (!m || turn.agentMessage || turn.afterToolCall || differentMessage) {
          m = {
            id: randomUUID(),
            sessionId,
            seq: store.nextSeq(sessionId),
            role: 'user',
            text: '',
            threadId: null,
            ...(messageId !== undefined ? { acpMessageId: messageId } : {})
          }
          store.insertMessage(m)
          turn.userMessage = m
          turn.agentMessage = undefined
          turn.afterToolCall = false
        }
        if (u.content.type === 'text') {
          m.text += u.content.text
          store.updateMessageText(m.id, m.text)
        } else if (u.content.type === 'image' && u.content.data) {
          m.attachments = [
            ...(m.attachments ?? []),
            { kind: 'image', name: 'image', mimeType: u.content.mimeType, data: u.content.data }
          ]
          store.updateMessageAttachments(m.id, m.attachments)
        }
        emit({ type: 'message', message: { ...m } })
        return
      }
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
          turn.userMessage = undefined
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
        // plan, thoughts, etc.: not shown.
        return
    }
  }

  private async onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    // Gloss runs agents without permission prompts (SPEC → Permissions): approve
    // every request. Prefer "allow once": "allow always" can make the agent save
    // a rule (e.g. into the project's settings).
    const allow =
      req.options.find((o) => o.kind === 'allow_once') ?? req.options.find((o) => o.kind === 'allow_always')
    if (!allow) {
      console.warn(`[gloss] permission request for "${req.toolCall.title ?? 'a tool'}" has no allow option`)
      return { outcome: { outcome: 'cancelled' } }
    }
    return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind === 'listItem' && b.kind === 'listItem') {
    return a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i])
  }
  if (a.kind === 'selection' && b.kind === 'selection') return a.start === b.start && a.end === b.end
  return false
}

/** Keeps only the anchor's known fields (it comes from the renderer). */
function normalizeAnchor(a: Anchor): Anchor {
  return a.kind === 'listItem'
    ? { kind: 'listItem', path: [...a.path], text: a.text }
    : { kind: 'selection', start: a.start, end: a.end, text: a.text }
}

function toAuthMethodInfo(m: acp.AuthMethod): AuthMethodInfo {
  return {
    id: m.id,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    kind: 'type' in m && m.type === 'terminal' ? 'terminal' : 'agent'
  }
}

/**
 * A plan usage window from Claude Code's rate-limit info, which the Claude adapter
 * attaches to usage updates as `_meta["_claude/rateLimit"]` (the Agent SDK's
 * SDKRateLimitInfo). Null if there is none or it isn't recognizable.
 */
export function claudeRateLimit(meta: unknown): RateLimit | null {
  const info = (meta as Record<string, unknown> | null | undefined)?.['_claude/rateLimit'] as
    | Record<string, unknown>
    | undefined
  if (!info || typeof info.rateLimitType !== 'string') return null
  const status = info.status === 'rejected' ? 'rejected' : info.status === 'allowed_warning' ? 'warning' : 'allowed'
  const limit: RateLimit = { window: info.rateLimitType, status }
  if (typeof info.utilization === 'number' && Number.isFinite(info.utilization)) {
    // Undocumented scale: treat values up to 1 as a fraction.
    const pct = info.utilization <= 1 ? info.utilization * 100 : info.utilization
    limit.utilization = Math.max(0, Math.min(100, Math.round(pct)))
  }
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    // Unix seconds.
    limit.resetsAt = info.resetsAt * 1000
  }
  return limit
}

/** The session state an update reports, if it is one of those. `rateLimits` is the current list, to merge into. */
function liveUpdate(u: acp.SessionUpdate, rateLimits: RateLimit[]): Partial<SessionLive> | null {
  switch (u.sessionUpdate) {
    case 'available_commands_update':
      return {
        commands: u.availableCommands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input?.hint ? { hint: c.input.hint } : {})
        }))
      }
    case 'usage_update': {
      const limit = claudeRateLimit(u._meta)
      return {
        usage: {
          used: u.used,
          size: u.size,
          ...(u.cost ? { cost: { amount: u.cost.amount, currency: u.cost.currency } } : {})
        },
        ...(limit ? { rateLimits: [...rateLimits.filter((l) => l.window !== limit.window), limit] } : {})
      }
    }
    case 'config_option_update':
      return { model: modelOption(u.configOptions) }
    default:
      return null
  }
}

/** The agent's model config option (category "model", a select), flattened. */
export function modelOption(options: acp.SessionConfigOption[]): SessionLive['model'] {
  const o = options.find((x) => x.category === 'model' && x.type === 'select')
  if (!o || o.type !== 'select') return null
  const flat = o.options.flatMap((x) => ('group' in x ? x.options : [x]))
  return {
    configId: o.id,
    current: o.currentValue,
    options: flat.map((x) => ({
      value: x.value,
      name: x.name,
      ...(x.description ? { description: x.description } : {})
    }))
  }
}

/** The prompt for a user message: its wire text, then the images and files the agent accepts. */
export function promptBlocks(
  wire: string,
  attachments: Attachment[],
  caps: acp.PromptCapabilities
): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = wire.trim() ? [{ type: 'text', text: wire }] : []
  for (const a of attachments) {
    if (a.kind === 'image') {
      if (!caps.image) throw new Error("The agent doesn't accept images.")
      blocks.push({ type: 'image', data: a.data, mimeType: a.mimeType })
    } else {
      if (!caps.embeddedContext) throw new Error("The agent doesn't accept attached files.")
      blocks.push({
        type: 'resource',
        resource: {
          uri: a.path ? pathToFileURL(a.path).href : `file:///${encodeURIComponent(a.name)}`,
          text: a.text,
          ...(a.mimeType ? { mimeType: a.mimeType } : {})
        }
      })
    }
  }
  return blocks
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
