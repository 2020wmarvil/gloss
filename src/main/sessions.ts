// Owns agent connections, session attachment, turns and sign-in.
// The agent sees one linear ACP session per Gloss session. When the agent can load
// its sessions, its copy is the source of truth for the log (SPEC → Shared sessions).
import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import { pathToFileURL } from 'node:url'
import type { GlossEvent, PullRequest, SessionView, TurnResult } from '../shared/ipc'
import type {
  AgentSession,
  Anchor,
  Attachment,
  AuthMethodInfo,
  ConfigChoice,
  Message,
  MessageQueue,
  Plan,
  PlanEntry,
  Project,
  RateLimit,
  Session,
  SessionLive,
  SlashCommand,
  Thread,
  ToolCall,
  TurnOutcome
} from '../shared/types'
import { AGENT_INSTRUCTIONS, wireText } from '../shared/wire'
import {
  findingsBlocks,
  findingThread,
  firstPassPrompt,
  isCommitId,
  linesOf,
  rangeNote,
  REVIEW_INSTRUCTIONS,
  type ReviewCommit,
  type ReviewDiff,
  type ReviewRange,
  type ReviewRefs
} from '../shared/review'
import type { McpServer } from '../shared/mcp'
import { AgentConnection, isAuthRequired, isResourceNotFound, isSessionInUse, type AgentHandlers, type SteerOutcome } from './acp'
import type { AgentConfig } from './agents'
import type { Store } from './db'
import { samePath } from './settings'
import { isLogUpdate, matchReplay, parseReplay, placeUserMessage, type CachedEntry } from './sync'
import type { TerminalRunner } from './terminal'
import { originRepoUrl, pullRequest } from './git'
import { currentBranch, defaultBranch, mergeBase, pullRequestBase, readReviewDiff, readReviewFile, reviewCommits, workingFilePath } from './review'

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
  mcpServers?(cwd: string): McpServer[]
  /** Git for review sessions; the real one by default. */
  git?: ReviewGit
}

/** What review sessions need from git (SPEC → Review sessions). */
export type ReviewGit = {
  pullRequest(cwd: string): Promise<PullRequest | null>
  pullRequestBase(cwd: string, branch: string, fetch?: boolean): Promise<string | null>
  defaultBranch(cwd: string): Promise<string | null>
  currentBranch(cwd: string): Promise<string | null>
  mergeBase(cwd: string, ref: string): Promise<string | null>
  commits(cwd: string, since: string | null): Promise<ReviewCommit[]>
  repoUrl(cwd: string): Promise<string | null>
  readDiff(cwd: string, baseRef: string, headRef: string | null): Promise<ReviewDiff>
  readFile(cwd: string, path: string, headRef: string | null): Promise<string[] | null>
}

const GIT: ReviewGit = {
  pullRequest,
  pullRequestBase,
  defaultBranch,
  currentBranch,
  mergeBase,
  commits: reviewCommits,
  repoUrl: originRepoUrl,
  readDiff: readReviewDiff,
  readFile: readReviewFile
}

type Turn = {
  threadId: string | null
  /** The agent message that text chunks currently append to. */
  agentMessage?: Message
  /** A tool call or a new plan arrived since the last text; the next text starts a new message below it. */
  afterToolCall: boolean
  /** The plan reported in this turn; later reports replace its entries. */
  plan?: Plan
  cancelled: boolean
  /** The user message that starts the turn, until it is sent: the agent's copy doesn't have it yet. */
  unsent?: string
  /** The user messages sent in it (the first, and any steered in), which record how it ended. */
  messageIds: string[]
}

type SessionRuntime = {
  mcpFingerprint?: string
  /** A review's range changed: told to the agent at the start of the next message (SPEC → Review sessions). */
  rangeNote?: string
  /** The connection the session's ACP session is live on. */
  attachedTo?: AgentConnection
  /** An attach in progress, so concurrent callers share it. */
  attaching?: { conn: AgentConnection; promise: Promise<string> }
  /** session/load is replaying history, collected in `replay` and then synced. */
  loading: boolean
  replay?: acp.SessionUpdate[]
  /** The session is being imported: a failed load removes it instead of starting a new agent session. */
  importing?: boolean
  turn?: Turn
  /** Messages sent while a turn was running (SPEC → Queue). */
  queue: MessageQueue
  live: SessionLive
}

/** Slash commands Gloss runs itself instead of sending them to the agent. */
const GLOSS_COMMANDS: SlashCommand[] = [{ name: 'clear', description: 'Start over with a fresh conversation' }]

function emptyLive(): SessionLive {
  return {
    attached: false,
    model: null,
    effort: null,
    commands: GLOSS_COMMANDS,
    usage: null,
    rateLimits: [],
    permissions: null,
    accepts: { image: false, file: false },
    steering: false
  }
}

type SignIn = { promise: Promise<boolean>; resolve(ok: boolean): void }

type AgentSlot = {
  connection?: Promise<AgentConnection>
  /** The resolved connection, once `connection` has started. */
  current?: AgentConnection
  /** session/prompt requests in flight. */
  activePrompts: number
  signIn?: SignIn
}

const TITLE_LENGTH = 60

export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in was cancelled.')
  }
}

/** The agent no longer has the session (it was deleted outside Gloss), so Gloss deleted it too. */
export class SessionGoneError extends Error {
  constructor() {
    super('The agent no longer has this session (it was deleted outside Gloss), so it was removed.')
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
      rt = { loading: false, queue: { items: [], paused: false }, live: emptyLive() }
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

  /** The agent's `_meta` for session/new or session/load (SPEC → Agent instructions). Review sessions add theirs. */
  private sessionMeta(agentId: string, request: 'new' | 'load', review = false): Record<string, unknown> | undefined {
    const instructions = review ? `${AGENT_INSTRUCTIONS}\n${REVIEW_INSTRUCTIONS}` : AGENT_INSTRUCTIONS
    return this.deps.getAgentConfig(agentId).sessionMeta?.(instructions)[request]
  }

  private get git(): ReviewGit {
    return this.deps.git ?? GIT
  }

  private mcpServers(cwd: string): McpServer[] {
    return this.deps.mcpServers?.(cwd) ?? []
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
    try {
      ;(await pending).dispose()
    } catch {
      // It never started; nothing to stop.
    }
    this.detachClosed()
    return true
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

  /** What the user sent, in every session, newest first and each once (SPEC → Composer → History). */
  messageHistory(): string[] {
    return this.deps.store.messageHistory()
  }

  /** `review`: a review session (SPEC → Review sessions), with its title. */
  async createSession(cwd: string, agentId: string, review?: ReviewRange & { title: string }): Promise<Session> {
    const servers = this.mcpServers(cwd)
    let conn!: AgentConnection
    let permissions: SessionLive['permissions'] = null
    const res = await this.withAgent(agentId, async (c) => {
      conn = c
      const created = await c.newSession(cwd, this.sessionMeta(agentId, 'new', review !== undefined), servers)
      permissions = await this.enterBypassMode(agentId, c, created.sessionId, created.modes)
      return created
    })
    const session: Session = {
      id: randomUUID(),
      agentId,
      acpSessionId: res.sessionId,
      cwd,
      title: review?.title ?? folderName(cwd),
      // The agent would title a review after the first pass's prompt.
      ...(review ? { titleSet: true as const, review: { baseRef: review.baseRef, ...(review.headRef ? { headRef: review.headRef } : {}) } } : {}),
      createdAt: this.now()
    }
    this.deps.store.insertSession(session)
    this.deps.store.addProject(cwd, this.now())
    this.register(session.acpSessionId, session.id)
    this.runtime(session.id).attachedTo = conn
    this.runtime(session.id).mcpFingerprint = JSON.stringify(servers)
    const created = this.session(session.id)
    this.deps.emit({ type: 'session', session: created })
    await this.attached(session.id, conn, res.configOptions, permissions)
    return created
  }

  /**
   * Starts a review of the project's branch (SPEC → Review sessions) and sends the first
   * pass. Without a `range` it compares the working tree with the merge base of the
   * branch's open pull request's base, else of the default branch; **New review** passes
   * the range of the review it replaces. Resolves once the session exists; the first
   * pass runs on.
   */
  async createReview(cwd: string, agentId: string, range?: ReviewRange): Promise<Session> {
    const found = await this.git.pullRequest(cwd)
    const pr = found && (found.state === 'open' || found.state === 'draft') && found.baseRef ? found : null
    const prBase = pr && (await this.git.pullRequestBase(cwd, pr.baseRef, range === undefined))
    const baseRef = range?.baseRef ?? (prBase || (await this.git.defaultBranch(cwd)))
    if (!baseRef) throw new Error('A review needs a git repository with a default branch (origin/HEAD, main or master).')
    const headRef = range?.headRef
    const diff = await this.git.readDiff(cwd, baseRef, headRef ?? null)
    const branch = await this.git.currentBranch(cwd)
    // It reviews the pull request only while it compares the working tree with the PR's base.
    const ofPr = pr && baseRef === prBase && headRef === undefined ? pr : null
    const title = ofPr ? `Review: #${ofPr.number} ${ofPr.title}` : `Review: ${branch ?? folderName(cwd)}`
    const session = await this.createSession(cwd, agentId, { baseRef, ...(headRef ? { headRef } : {}), title })
    // Turn errors arrive as turnEnd events.
    this.send(session.id, firstPassPrompt(diff, ofPr?.number), null).catch((err: unknown) =>
      this.notice(session.id, null, `Couldn't start the first pass: ${errorMessage(err)}`)
    )
    return session
  }

  /** A review session's range. */
  private reviewOf(sessionId: string): { session: Session; review: ReviewRange } {
    const session = this.session(sessionId)
    if (!session.review) throw new Error('Only a review session has a diff.')
    return { session, review: session.review }
  }

  /** The diff a review session shows, read now. */
  reviewDiff(sessionId: string): Promise<ReviewDiff> {
    const { session, review } = this.reviewOf(sessionId)
    return this.git.readDiff(session.cwd, review.baseRef, review.headRef ?? null)
  }

  /** Where a file of a review session's diff is in the working tree, to open it outside Gloss. */
  reviewFilePath(sessionId: string, path: string): Promise<string> {
    return workingFilePath(this.reviewOf(sessionId).session.cwd, path)
  }

  /** A file of a review session's diff on its new side, for showing the lines around its hunks. */
  reviewFile(sessionId: string, path: string): Promise<string[] | null> {
    const { session, review } = this.reviewOf(sessionId)
    return this.git.readFile(session.cwd, path, review.headRef ?? null)
  }

  /**
   * What a review's dropdowns offer (SPEC → Review sessions → What is reviewed): the
   * default branch, the open pull request's base and the session's own base branch to
   * take the merge base with, and the branch's recent commits.
   */
  async reviewRefs(sessionId: string): Promise<ReviewRefs> {
    const { session, review } = this.reviewOf(sessionId)
    const { cwd } = session
    const pr = await this.git.pullRequest(cwd).catch(() => null)
    const branch = await this.git.defaultBranch(cwd)
    const prBase = pr && (pr.state === 'open' || pr.state === 'draft') && pr.baseRef ? await this.git.pullRequestBase(cwd, pr.baseRef, false) : null
    const defaultBase = prBase ?? branch
    // The default first.
    const candidates = [defaultBase, branch, prBase, isCommitId(review.baseRef) ? null : review.baseRef]
    const bases: ReviewRefs['bases'] = []
    for (const ref of new Set(candidates.filter((r): r is string => r !== null))) {
      const sha = await this.git.mergeBase(cwd, ref)
      if (sha) bases.push({ ref, sha })
    }
    const since = bases.find((b) => b.ref === branch)?.sha ?? bases[0]?.sha ?? null
    return { bases, commits: await this.git.commits(cwd, since), repoUrl: await this.git.repoUrl(cwd), defaultBase }
  }

  /**
   * Changes what a review compares. The agent is told at the start of the next message.
   * Rejects a ref that doesn't name a commit. Resolves with the new diff.
   */
  async setReviewRange(sessionId: string, range: ReviewRange): Promise<ReviewDiff> {
    const { session } = this.reviewOf(sessionId)
    for (const ref of [range.baseRef, range.headRef]) {
      if (ref !== undefined && (ref === '' || ref.startsWith('-'))) throw new Error(`Not a commit: ${ref}`)
    }
    const diff = await this.git.readDiff(session.cwd, range.baseRef, range.headRef ?? null)
    if (!this.deps.store.getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`)
    const updated = this.deps.store.updateSession(sessionId, { review: range })
    this.runtime(sessionId).rangeNote = rangeNote(diff)
    this.deps.emit({ type: 'session', session: updated })
    return diff
  }

  /**
   * Opens a line thread for each finding the agent listed in its answers since
   * `sinceSeq` that has none yet (SPEC → Review sessions → First pass). Findings on
   * lines the diff doesn't show stay in the message, which lists them.
   */
  private async openFindings(sessionId: string, sinceSeq: number): Promise<void> {
    const { store } = this.deps
    const session = store.getSession(sessionId)
    if (!session?.review) return
    const found = store
      .listMessages(sessionId)
      .filter((m) => m.role === 'agent' && m.threadId === null && m.seq > sinceSeq)
      .flatMap((m) => findingsBlocks(m.text).flatMap((b) => b.findings))
    if (found.length === 0) return
    let diff: ReviewDiff
    try {
      diff = await this.git.readDiff(session.cwd, session.review.baseRef, session.review.headRef ?? null)
    } catch (err) {
      this.notice(sessionId, null, `Couldn't read the diff to open the agent's findings: ${errorMessage(err)}`)
      return
    }
    if (!store.getSession(sessionId)) return
    const threads = store.listThreads(sessionId)
    for (const f of found) {
      if (findingThread(f, threads)) continue
      const file = diff.files.find((x) => x.path === f.file)
      const lines = file ? linesOf(file, f.side, f.start, f.end) : null
      if (!lines) continue
      const thread: Thread = {
        id: randomUUID(),
        sessionId,
        anchorMessageId: null,
        anchor: { kind: 'line', file: f.file, side: f.side, start: f.start, end: f.end, text: lines.join('\n'), lines },
        finding: { severity: f.severity, title: f.title, body: f.body },
        createdAt: this.now()
      }
      store.insertThread(thread)
      threads.push(thread)
      this.deps.emit({ type: 'thread', thread })
    }
    this.deps.emit({ type: 'session', session: this.session(sessionId) })
  }

  /**
   * Imports one of the agent's sessions: a Gloss session whose log is built from the
   * session/load replay. The agent doesn't say when it was made, so `listedAt` (its
   * updatedAt in the listing) stands in, keeping its place in the session list.
   */
  async importSession(
    cwd: string,
    agentId: string,
    acpSessionId: string,
    title: string,
    listedAt?: string
  ): Promise<Session> {
    const existing = this.deps.store.getSessionByAcpId(agentId, acpSessionId)
    if (existing) return existing
    const listed = listedAt ? Date.parse(listedAt) : NaN
    const session: Session = {
      id: randomUUID(),
      agentId,
      acpSessionId,
      cwd,
      title: title.trim() || folderName(cwd),
      createdAt: Number.isFinite(listed) ? listed : this.now()
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
        // The load's replay is synced into the empty log.
        rt.importing = true
        try {
          await this.attach(session.id, conn)
        } catch (err) {
          if (!isResourceNotFound(err)) throw err
          // Listed but not loadable: a leftover of a deleted session (Claude Code
          // can rewrite a transcript's metadata after its delete). Remove it.
          if (conn.canDeleteSessions) await this.deleteAgentSession(conn, agentId, acpSessionId).catch(() => {})
          throw new Error('That session has no conversation left (it was probably deleted), so it was removed.', {
            cause: err
          })
        }
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
    const imported = this.session(session.id)
    this.deps.emit({ type: 'session', session: imported })
    return imported
  }

  /** Its log and threads. Resumes it on the agent in the background, or checks it for changes made elsewhere. */
  openSession(id: string): SessionView {
    const session = this.session(id)
    const rt = this.runtime(id)
    if (!rt.attachedTo) void this.resume(id)
    else void this.refreshSession(id)
    return {
      session,
      messages: this.deps.store.listMessages(id),
      toolCalls: this.deps.store.listToolCalls(id),
      plans: this.deps.store.listPlans(id),
      threads: this.deps.store.listThreads(id),
      turn: rt.turn ? { threadId: rt.turn.threadId } : null,
      queue: rt.queue,
      live: rt.live
    }
  }

  /** Resumes the session on the agent so the status line has its model, commands and usage. */
  private async resume(id: string): Promise<void> {
    const session = this.session(id)
    try {
      await this.withAgent(session.agentId, (conn) => this.attach(id, conn))
    } catch (err) {
      if (this.disposed || err instanceof SignInCancelledError || err instanceof SessionGoneError) return
      if (!this.deps.store.getSession(id)) return
      this.notice(id, null, `Couldn't resume the session on the agent: ${errorMessage(err)}`)
    }
  }

  /**
   * Reloads a session that is running on the agent if its saved history changed
   * elsewhere (SPEC → Shared sessions). For opening it and the window regaining focus.
   */
  async refreshSession(id: string): Promise<void> {
    const rt = this.runtimes.get(id)
    // A load in progress gets the latest history; then check again.
    await rt?.attaching?.promise.catch(() => {})
    const conn = rt?.attachedTo
    if (!rt || !conn || rt.turn || rt.attaching || this.disposed) return
    try {
      await this.attach(id, conn)
      await this.ensureFresh(id, conn, () => !rt.turn)
    } catch (err) {
      if (this.disposed || err instanceof SignInCancelledError || err instanceof SessionGoneError) return
      if (!this.deps.store.getSession(id)) return
      this.notice(id, null, `Couldn't reload the session from the agent: ${errorMessage(err)}`)
    }
  }

  renameSession(id: string, title: string): Session {
    this.session(id)
    const trimmed = title.replace(/\s+/g, ' ').trim()
    if (!trimmed) throw new Error('A session needs a title.')
    const session = this.deps.store.updateSession(id, { title: trimmed.slice(0, 200), titleSet: true })
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
        if (conn.canDeleteSessions) await this.deleteAgentSession(conn, session.agentId, session.acpSessionId)
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

  /** session/delete, remembering the id so a copy the agent lists again stays hidden (see agentSessions). */
  private deleteAgentSession(conn: AgentConnection, agentId: string, acpSessionId: string): Promise<void> {
    this.deps.store.addDeletedAgentSession(agentId, acpSessionId)
    return conn.deleteSession(acpSessionId)
  }

  /**
   * `/clear`: replaces the session's agent session with a fresh one, in place.
   * The old one is deleted, the agent's copy too (session/delete, when advertised),
   * along with the session's messages, tool calls, threads and queue.
   */
  async clearSession(id: string): Promise<void> {
    let session = this.session(id)
    const servers = this.mcpServers(session.cwd)
    const rt = this.runtime(id)
    if (rt.turn) throw new Error('Cancel the running turn before clearing the session.')
    // A resume in progress would attach the old agent session after this.
    await rt.attaching?.promise.catch(() => {})
    let conn!: AgentConnection
    let permissions: SessionLive['permissions'] = null
    const res = await this.withAgent(session.agentId, async (c) => {
      conn = c
      const created = await c.newSession(session.cwd, this.sessionMeta(session.agentId, 'new', !!session.review), servers)
      permissions = await this.enterBypassMode(session.agentId, c, created.sessionId, created.modes)
      return created
    })
    if (rt.turn) throw new Error('Cancel the running turn before clearing the session.')

    const old = session.acpSessionId
    const hadMessages = this.deps.store.countUserMessages(id) > 0
    this.byAcpId.delete(old)
    this.deps.store.clearLog(id)
    session = this.deps.store.updateSession(id, { acpSessionId: res.sessionId, syncedAt: null })
    this.register(session.acpSessionId, id)
    rt.attachedTo = conn
    rt.mcpFingerprint = JSON.stringify(servers)
    this.setQueue(id, { items: [], paused: false })
    this.setLive(id, { usage: null })
    this.deps.emit({ type: 'session', session })
    this.deps.emit({ type: 'sessionCleared', sessionId: id })
    await this.attached(id, conn, res.configOptions, permissions)

    if (conn.canDeleteSessions) {
      try {
        await this.deleteAgentSession(conn, session.agentId, old)
      } catch (err) {
        // Claude Code writes its transcript on the first prompt: an unused session has nothing to delete.
        if (hadMessages) this.notice(id, null, `Cleared, but the agent couldn't delete the old conversation: ${errorMessage(err)}`)
      }
    }
  }

  /** Picks the session's model or effort via the agent's config option, and saves it on the session. */
  async setChoice(id: string, kind: 'model' | 'effort', value: string): Promise<void> {
    const session = this.session(id)
    await this.withAgent(session.agentId, async (conn) => {
      const acpSessionId = await this.attach(id, conn)
      const choice = this.runtime(id).live[kind]
      if (!choice) throw new Error(`The agent doesn't offer a choice of ${kind}.`)
      const res = await conn.setConfigOption(acpSessionId, choice.configId, value)
      let choices = configChoices(res.configOptions)
      // A new model can leave the effort at "default" (its levels differ): pin a level again.
      if (kind === 'model') choices = await this.settleEffort(conn, acpSessionId, choices, session.effort)
      this.setLive(id, choices)
    })
    const updated = this.deps.store.updateSession(id, { [kind]: value })
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

  /**
   * The agent's sessions in `cwd` that Gloss has no record of (session/list, when
   * advertised). Gloss's own sessions there take the agent's title unless renamed in Gloss.
   */
  async agentSessions(cwd: string, agentId: string): Promise<AgentSession[]> {
    const deleted = new Set(this.deps.store.listDeletedAgentSessions(agentId))
    const listed = await this.withAgent(agentId, async (conn) => {
      if (!conn.canListSessions) return []
      const sessions = await conn.listSessions(cwd)
      // Claude Code's process can rewrite a transcript's metadata after its
      // delete, bringing the session back without its conversation. Delete it again.
      for (const s of sessions) {
        if (deleted.has(s.sessionId) && conn.canDeleteSessions) void conn.deleteSession(s.sessionId).catch(() => {})
      }
      return sessions
    })
    const { store } = this.deps
    const mine = new Map(
      store
        .listSessions()
        .filter((s) => s.agentId === agentId)
        .map((s) => [s.acpSessionId, s])
    )
    for (const s of listed) {
      const session = mine.get(s.sessionId)
      const title = s.title?.replace(/\s+/g, ' ').trim().slice(0, 200)
      if (session && !session.titleSet && title && title !== session.title) {
        this.deps.emit({ type: 'session', session: store.updateSession(session.id, { title }) })
      }
    }
    const known = new Set([...deleted, ...mine.keys()])
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

  /** `anchorMessageId` is null for a line anchor, which only a review session has. */
  createThread(sessionId: string, anchorMessageId: string | null, anchor: Anchor): Thread {
    const session = this.session(sessionId)
    if (anchor.kind === 'line') {
      if (!session.review || anchorMessageId !== null) throw new Error('Only a review session has threads on diff lines.')
    } else {
      const message = anchorMessageId === null ? undefined : this.deps.store.getMessage(anchorMessageId)
      if (!message || message.sessionId !== sessionId || message.role !== 'agent') {
        throw new Error('Threads can only be anchored to an agent message in this session.')
      }
    }
    const valid =
      anchor.kind === 'listItem'
        ? anchor.path.length > 0 && anchor.path.every((i) => Number.isInteger(i) && i >= 0)
        : anchor.kind === 'selection'
          ? Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start < anchor.end
          : typeof anchor.file === 'string' &&
            anchor.file.trim() !== '' &&
            (anchor.side === 'old' || anchor.side === 'new') &&
            Number.isInteger(anchor.start) &&
            Number.isInteger(anchor.end) &&
            anchor.start >= 1 &&
            anchor.end >= anchor.start &&
            Array.isArray(anchor.lines) &&
            anchor.lines.length === anchor.end - anchor.start + 1 &&
            anchor.lines.every((l) => typeof l === 'string')
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
    if (anchor.kind === 'line') this.deps.emit({ type: 'session', session: this.session(sessionId) })
    return thread
  }

  /** Resolves a review thread, or reopens it (SPEC → Review sessions → Resolve). */
  resolveThread(sessionId: string, threadId: string, resolved: boolean): Thread {
    const thread = this.deps.store.getThread(threadId)
    if (!thread || thread.sessionId !== sessionId) throw new Error(`Unknown thread ${threadId}`)
    if (thread.anchor.kind !== 'line') throw new Error('Only threads on diff lines can be resolved.')
    const at = resolved ? this.now() : null
    this.deps.store.setThreadResolved(threadId, at)
    const updated: Thread = { ...thread }
    if (at === null) delete updated.resolvedAt
    else updated.resolvedAt = at
    this.deps.emit({ type: 'thread', thread: updated })
    this.deps.emit({ type: 'session', session: this.session(sessionId) })
    return updated
  }

  private notice(sessionId: string, threadId: string | null, text: string): void {
    this.deps.emit({ type: 'notice', sessionId, threadId, text })
  }

  /** Makes the session's ACP session live on `conn`. Concurrent callers share one attach. */
  private attach(sessionId: string, conn: AgentConnection): Promise<string> {
    const rt = this.runtime(sessionId)
    if (rt.attaching?.conn === conn) return rt.attaching.promise
    if (rt.attachedTo === conn) {
      const session = this.session(sessionId)
      const servers = this.mcpServers(session.cwd)
      if (rt.mcpFingerprint !== JSON.stringify(servers) && (!rt.turn || rt.turn.unsent)) {
        conn.validateMcp(servers)
        if (!conn.canCloseSessions || !conn.canLoadSession) {
          return Promise.reject(new Error('MCP settings changed. Restart Gloss to apply them for this agent.'))
        }
        return this.reattach(sessionId, conn)
      }
      return Promise.resolve(session.acpSessionId)
    }
    const promise = this.doAttach(sessionId, conn).finally(() => {
      if (rt.attaching?.promise === promise) rt.attaching = undefined
    })
    rt.attaching = { conn, promise }
    return promise
  }

  /**
   * session/load, syncing the log from its replay (SPEC → Shared sessions). An
   * agent that can't load gets a new session, with a notice that it lost context.
   */
  private async doAttach(sessionId: string, conn: AgentConnection): Promise<string> {
    const rt = this.runtime(sessionId)
    const session = this.session(sessionId)
    const servers = this.mcpServers(session.cwd)
    conn.validateMcp(servers)
    if (!conn.canLoadSession) return this.replaceAgentSession(sessionId, conn, true)

    // The agent's last change, before the load changes it: the time of what the replay adds.
    const before = await this.agentUpdatedAt(conn, session).catch(() => undefined)
    rt.loading = true
    rt.replay = []
    this.byAcpId.set(session.acpSessionId, session.id)
    let loaded: acp.LoadSessionResponse | undefined
    let replay: acp.SessionUpdate[]
    try {
      loaded = await conn.loadSession(session.acpSessionId, session.cwd, this.sessionMeta(session.agentId, 'load', !!session.review), servers)
    } catch (err) {
      if (isSessionInUse(err)) throw new Error('This session is open in Codex. Quit Codex to continue here.', { cause: err })
      if (isAuthRequired(err) || rt.importing) throw err
      if (!isResourceNotFound(err)) {
        console.error(`[gloss] session/load failed for ${sessionId}:`, errorMessage(err))
        throw new Error(`The agent couldn't resume it: ${errorMessage(err)}`, { cause: err })
      }
      // Deleted outside Gloss. A session that never had a message has no saved
      // history (Claude Code writes none until the first prompt): nothing is lost.
      if (this.deps.store.countUserMessages(sessionId) > (rt.turn?.unsent ? 1 : 0)) {
        this.removeDeletedOutside(sessionId)
        throw new SessionGoneError()
      }
    } finally {
      rt.loading = false
      replay = rt.replay ?? []
      rt.replay = undefined
    }
    if (!loaded) return this.replaceAgentSession(sessionId, conn, false)

    const at = before ? Date.parse(before) : NaN
    this.sync(sessionId, replay, Number.isFinite(at) ? at : this.now())
    const permissions = await this.enterBypassMode(session.agentId, conn, session.acpSessionId, loaded.modes)
    rt.attachedTo = conn
    rt.mcpFingerprint = JSON.stringify(servers)
    await this.attached(sessionId, conn, loaded.configOptions, permissions)
    await this.recordSynced(sessionId, conn)
    return session.acpSessionId
  }

  /** Starts a new agent session for a Gloss session whose own can't be loaded. */
  private async replaceAgentSession(sessionId: string, conn: AgentConnection, notice: boolean): Promise<string> {
    const rt = this.runtime(sessionId)
    let session = this.session(sessionId)
    const servers = this.mcpServers(session.cwd)
    const res = await conn.newSession(session.cwd, this.sessionMeta(session.agentId, 'new', !!session.review), servers)
    const permissions = await this.enterBypassMode(session.agentId, conn, res.sessionId, res.modes)
    this.byAcpId.delete(session.acpSessionId)
    session = this.deps.store.updateSession(session.id, { acpSessionId: res.sessionId, syncedAt: null })
    this.register(session.acpSessionId, session.id)
    rt.attachedTo = conn
    rt.mcpFingerprint = JSON.stringify(servers)
    this.deps.emit({ type: 'session', session })
    await this.attached(sessionId, conn, res.configOptions, permissions)
    if (notice) {
      this.notice(
        sessionId,
        rt.turn?.threadId ?? null,
        'Started a new agent session. The agent could not resume the previous one, so it does not remember the earlier messages shown here.'
      )
    }
    return session.acpSessionId
  }

  /** The agent's updatedAt for the session (session/list), if it lists sessions and has this one. */
  private async agentUpdatedAt(conn: AgentConnection, session: Session): Promise<string | undefined> {
    if (!conn.canListSessions) return undefined
    return (await conn.findSession(session.cwd, session.acpSessionId))?.updatedAt ?? undefined
  }

  /** Remembers the agent's updatedAt for the session, so a later change made elsewhere can be told apart. */
  private async recordSynced(sessionId: string, conn: AgentConnection): Promise<void> {
    const session = this.deps.store.getSession(sessionId)
    if (!session) return
    try {
      const updatedAt = await this.agentUpdatedAt(conn, session)
      if (updatedAt && updatedAt !== session.syncedAt && this.deps.store.getSession(sessionId)) {
        this.deps.store.updateSession(sessionId, { syncedAt: updatedAt })
      }
    } catch (err) {
      console.warn(`[gloss] could not list the agent's sessions:`, errorMessage(err))
    }
  }

  /**
   * Reloads the session (session/close, then session/load) if the agent's copy
   * changed since Gloss last synced it. `canReload` is checked again once the
   * agent has answered: a reload never interrupts a running prompt.
   */
  private async ensureFresh(sessionId: string, conn: AgentConnection, canReload: () => boolean): Promise<void> {
    const rt = this.runtime(sessionId)
    if (!conn.canLoadSession || !conn.canListSessions || !conn.canCloseSessions) return
    // A load in progress replays the latest history anyway.
    const loading = (): Promise<unknown> | undefined => (rt.attaching?.conn === conn ? rt.attaching.promise : undefined)
    if (loading()) return void (await loading())
    if (rt.attachedTo !== conn) return
    const updatedAt = await this.agentUpdatedAt(conn, this.session(sessionId))
    if (loading()) return void (await loading())
    if (!updatedAt || updatedAt === this.deps.store.getSession(sessionId)?.syncedAt) return
    if (rt.attachedTo !== conn || !canReload()) return
    await this.reattach(sessionId, conn)
  }

  /**
   * session/close, then attach again. The close is needed: a session/load of a
   * session the agent holds replays the new history but keeps its running copy,
   * whose model doesn't see it.
   */
  private reattach(sessionId: string, conn: AgentConnection): Promise<string> {
    const rt = this.runtime(sessionId)
    if (rt.attaching?.conn === conn) return rt.attaching.promise
    const acpSessionId = this.session(sessionId).acpSessionId
    rt.attachedTo = undefined
    const promise = (async () => {
      await conn.closeSession(acpSessionId)
      return this.doAttach(sessionId, conn)
    })().finally(() => {
      if (rt.attaching?.promise === promise) rt.attaching = undefined
    })
    rt.attaching = { conn, promise }
    return promise
  }

  /** Deletes a session the agent no longer has from Gloss too. */
  private removeDeletedOutside(sessionId: string): void {
    const session = this.session(sessionId)
    this.deps.store.deleteSession(sessionId)
    this.runtimes.delete(sessionId)
    this.byAcpId.delete(session.acpSessionId)
    this.deps.emit({ type: 'sessionDeleted', sessionId, deletedOutside: { title: session.title } })
  }

  /**
   * Makes the log match the agent's replay (SPEC → Shared sessions). Entries
   * new to Gloss are recorded at `at` and placed in threads by their tags.
   */
  private sync(sessionId: string, updates: acp.SessionUpdate[], at: number): void {
    const { store } = this.deps
    // A turn's message that isn't sent yet stays last.
    const unsent = this.runtime(sessionId).turn?.unsent
    const messages = store.listMessages(sessionId)
    const cached: CachedEntry[] = [
      ...messages.filter((m) => m.id !== unsent).map((message): CachedEntry => ({ type: 'message', message })),
      ...store.listToolCalls(sessionId).map((toolCall): CachedEntry => ({ type: 'toolCall', toolCall })),
      ...store.listPlans(sessionId).map((plan): CachedEntry => ({ type: 'plan', plan }))
    ].sort((a, b) => seqOf(a) - seqOf(b))
    const { log, removed } = matchReplay(cached, parseReplay(updates))
    const last = messages.find((m) => m.id === unsent)
    if (last) log.push({ cached: { type: 'message', message: last } })

    const changed =
      removed.length > 0 ||
      log.some((item, i) => {
        if (!item.cached) return true
        if (seqOf(item.cached) !== i) return true
        const r = item.replay
        if (r?.type === 'agent' && item.cached.type === 'message') return r.text !== item.cached.message.text
        if (r?.type === 'tool' && item.cached.type === 'toolCall') return toolStatus(item.cached.toolCall, r.toolCall) !== null
        return false
      })
    if (!changed) return

    store.transaction(() => {
      for (const c of removed) {
        // Threads anchored on a removed message go with it.
        if (c.type === 'message') store.deleteMessage(c.message.id)
        else if (c.type === 'toolCall') store.deleteToolCall(sessionId, c.toolCall.id)
      }
      const threads = store.listThreads(sessionId)
      /** Thread id → position of its latest user message, to rank threads a tag could name. */
      const active = new Map<string, number>()
      /** The thread of the latest user message: where the agent's answer goes. */
      let threadId: string | null = null
      const entries = log.map((item, i): Parameters<Store['resequence']>[1][number] => {
        const c = item.cached
        const r = item.replay
        if (c?.type === 'message') {
          if (c.message.role === 'user') {
            threadId = c.message.threadId
            if (threadId) active.set(threadId, i)
          }
          if (r?.type === 'agent' && r.text !== c.message.text) store.updateMessageText(c.message.id, r.text)
          return { kind: 'message', id: c.message.id }
        }
        if (c?.type === 'toolCall') {
          const status = r?.type === 'tool' ? toolStatus(c.toolCall, r.toolCall) : null
          if (status) store.upsertToolCall({ ...c.toolCall, status })
          return { kind: 'toolCall', id: c.toolCall.id }
        }
        if (c?.type === 'plan') return { kind: 'plan', id: c.plan.id }

        const entry = r!
        if (entry.type === 'user') {
          const placed = placeUserMessage(entry.wire, threads, active)
          threadId = placed.threadId
          if (threadId) active.set(threadId, i)
          return {
            insert: (seq) =>
              store.insertMessage({
                id: randomUUID(),
                sessionId,
                seq,
                role: 'user',
                text: placed.text,
                wireText: entry.wire,
                threadId: placed.threadId,
                ...(entry.acpMessageId !== undefined ? { acpMessageId: entry.acpMessageId } : {}),
                ...(entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
                createdAt: at
              })
          }
        }
        const thread = threadId
        switch (entry.type) {
          case 'agent':
            return {
              insert: (seq) =>
                store.insertMessage({
                  id: randomUUID(),
                  sessionId,
                  seq,
                  role: 'agent',
                  text: entry.text,
                  threadId: thread,
                  ...(entry.acpMessageId !== undefined ? { acpMessageId: entry.acpMessageId } : {}),
                  createdAt: at
                })
            }
          case 'tool':
            return { insert: (seq) => store.upsertToolCall({ ...entry.toolCall, sessionId, messageSeq: seq, threadId: thread }) }
          case 'plan':
            return {
              insert: (seq) => store.upsertPlan({ id: randomUUID(), sessionId, seq, threadId: thread, entries: entry.entries })
            }
        }
      })
      store.resequence(sessionId, entries)
    })
    this.deps.emit({ type: 'session', session: this.session(sessionId) })
    this.deps.emit({ type: 'sessionSynced', sessionId })
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

  /** Records what the agent reported on attach, and re-applies the session's model, then its effort (whose levels depend on the model). */
  private async attached(
    sessionId: string,
    conn: AgentConnection,
    configOptions: acp.SessionConfigOption[] | null | undefined,
    permissions: SessionLive['permissions']
  ): Promise<void> {
    const caps = conn.promptCapabilities
    let choices = configChoices(configOptions ?? [])
    const session = this.session(sessionId)
    const model = choices.model
    const wanted = session.model
    if (wanted && model && model.current !== wanted && model.options.some((o) => o.value === wanted)) {
      try {
        const res = await conn.setConfigOption(session.acpSessionId, model.configId, wanted)
        choices = configChoices(res.configOptions)
      } catch (err) {
        console.warn(`[gloss] could not set the model to "${wanted}":`, errorMessage(err))
      }
    }
    choices = await this.settleEffort(conn, session.acpSessionId, choices, session.effort)
    this.setLive(sessionId, {
      attached: true,
      ...choices,
      permissions,
      accepts: { image: caps.image === true, file: caps.embeddedContext === true },
      steering: conn.canSteer
    })
  }

  /**
   * Sets the session's effort: its own pick when the model offers it, else a concrete
   * level instead of the agent's "default" (SPEC → Status line → effort).
   */
  private async settleEffort(
    conn: AgentConnection,
    acpSessionId: string,
    choices: Pick<SessionLive, 'model' | 'effort'>,
    wanted: string | undefined
  ): Promise<Pick<SessionLive, 'model' | 'effort'>> {
    const effort = choices.effort
    const target = effort && concreteEffort(effort, wanted)
    if (!effort || !target || target === effort.current) return choices
    try {
      const res = await conn.setConfigOption(acpSessionId, effort.configId, target)
      return configChoices(res.configOptions)
    } catch (err) {
      console.warn(`[gloss] could not set the effort to "${target}":`, errorMessage(err))
      return choices
    }
  }

  // Turns

  /**
   * Sends a message, or queues it if a turn is running (SPEC → Queue). Resolves
   * when the turn ends, or right away with `queued`. `fromThread`: a main-thread
   * message sent from that thread's composer (SPEC → Send to main).
   */
  async send(
    sessionId: string,
    text: string,
    threadId: string | null,
    attachments: Attachment[] = [],
    fromThread: string | null = null
  ): Promise<TurnResult> {
    this.session(sessionId)
    this.anchorOf(sessionId, threadId)
    if (fromThread !== null) {
      if (threadId !== null) throw new Error('Only a main-thread message can be sent from a thread.')
      this.anchorOf(sessionId, fromThread)
    }
    if (isClear(text, attachments)) {
      await this.clearSession(sessionId)
      return { cleared: true }
    }
    const rt = this.runtime(sessionId)
    if (rt.turn) {
      this.setQueue(sessionId, {
        ...rt.queue,
        items: [
          ...rt.queue.items,
          { id: randomUUID(), threadId, text, attachments, ...(fromThread !== null ? { fromThread } : {}) }
        ]
      })
      return { queued: true }
    }
    return this.runTurn(sessionId, text, threadId, attachments, fromThread)
  }

  /**
   * Injects a message into the running turn (SPEC → Steer), in the thread the
   * turn runs in, so its reply is routed there too. When the session is idle it
   * is sent as usual; when the turn is ending or hasn't reached the agent yet, it
   * goes to the front of the queue.
   */
  async steer(
    sessionId: string,
    text: string,
    threadId: string | null,
    attachments: Attachment[] = []
  ): Promise<TurnResult> {
    this.session(sessionId)
    if (isClear(text, attachments)) return this.send(sessionId, text, threadId, attachments)
    const wire = this.wire(sessionId, text, threadId)
    const rt = this.runtime(sessionId)
    const turn = rt.turn
    if (!turn) return this.runTurn(sessionId, text, threadId, attachments)
    if (turn.threadId !== threadId) {
      throw new Error('Only the thread the agent is working in can be steered. Queue the message instead.')
    }
    const conn = rt.attachedTo
    if (conn && !conn.canSteer) throw new Error("The agent can't take a message during a turn. Queue it instead.")

    const toQueue = (): TurnResult => {
      // Nothing reached the agent: send it next.
      this.setQueue(sessionId, {
        ...rt.queue,
        items: [{ id: randomUUID(), threadId, text, attachments }, ...rt.queue.items]
      })
      this.drain(sessionId)
      return { queued: true }
    }
    if (!conn || rt.loading || turn.cancelled) return toQueue()
    const prompt = promptBlocks(wire, attachments, conn.promptCapabilities)

    // Recorded before it is sent: the agent may start answering before it replies.
    const message: Message = {
      id: randomUUID(),
      sessionId,
      seq: this.deps.store.nextSeq(sessionId),
      role: 'user',
      text,
      wireText: wire,
      threadId,
      ...(attachments.length > 0 ? { attachments } : {}),
      steered: true,
      createdAt: this.now()
    }
    this.deps.store.insertMessage(message)
    this.told(sessionId, wire)
    this.deps.emit({ type: 'message', message })
    turn.messageIds.push(message.id)
    // The agent's answer to it starts a new message below it.
    const before = { agentMessage: turn.agentMessage, afterToolCall: turn.afterToolCall }
    turn.agentMessage = undefined
    turn.afterToolCall = false

    let outcome: SteerOutcome
    try {
      outcome = await conn.steer(this.session(sessionId).acpSessionId, prompt)
    } catch (err) {
      this.unsteer(message, turn, before)
      throw err
    }
    if (outcome === 'promptRequired') {
      this.unsteer(message, turn, before)
      return toQueue()
    }
    return { steered: true }
  }

  /** Takes back a steered message that didn't get into the turn. */
  private unsteer(message: Message, turn: Turn, before: Pick<Turn, 'agentMessage' | 'afterToolCall'>): void {
    this.deps.store.deleteMessage(message.id)
    this.deps.emit({ type: 'messageDeleted', sessionId: message.sessionId, messageId: message.id })
    turn.messageIds = turn.messageIds.filter((id) => id !== message.id)
    // Nothing was written since: keep appending to the message it interrupted.
    if (!turn.agentMessage && !turn.afterToolCall) Object.assign(turn, before)
  }

  /** What to send for a new user message (SPEC → Wire format). Call it before the message is stored. */
  private wire(sessionId: string, text: string, threadId: string | null, fromThread: string | null = null): string {
    const afterThread = threadId === null && (this.deps.store.lastUserMessage(sessionId)?.threadId ?? null) !== null
    const wire = wireText(text, this.anchorOf(sessionId, threadId), afterThread, this.anchorOf(sessionId, fromThread))
    const note = this.runtime(sessionId).rangeNote
    return note ? `${note}\n${wire}` : wire
  }

  /** A message was recorded: a range note it carried has been told. */
  private told(sessionId: string, wire: string): void {
    const rt = this.runtime(sessionId)
    if (rt.rangeNote && wire.startsWith(`${rt.rangeNote}\n`)) rt.rangeNote = undefined
  }

  /** The anchor of a thread in the session (for the wire tag), or null for the main thread. */
  private anchorOf(sessionId: string, threadId: string | null): Anchor | null {
    if (threadId === null) return null
    const thread = this.deps.store.getThread(threadId)
    if (!thread || thread.sessionId !== sessionId) throw new Error(`Unknown thread ${threadId}`)
    return thread.anchor
  }

  private async runTurn(
    sessionId: string,
    text: string,
    threadId: string | null,
    attachments: Attachment[],
    fromThread: string | null = null
  ): Promise<TurnResult> {
    let session = this.session(sessionId)
    const rt = this.runtime(sessionId)
    if (rt.turn) throw new Error('A turn is already running in this session.')
    const wire = this.wire(sessionId, text, threadId, fromThread)
    // Only a session still named after its folder takes its title from the first message.
    const retitle = this.deps.store.countUserMessages(sessionId) === 0 && session.title === folderName(session.cwd)
    const message: Message = {
      id: randomUUID(),
      sessionId,
      seq: this.deps.store.nextSeq(sessionId),
      role: 'user',
      text,
      wireText: wire,
      threadId,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: this.now()
    }
    this.deps.store.insertMessage(message)
    this.told(sessionId, wire)
    this.deps.emit({ type: 'message', message })
    if (retitle) {
      session = this.deps.store.updateSession(sessionId, { title: titleFrom(text) })
      this.deps.emit({ type: 'session', session })
    }

    const turn: Turn = { threadId, cancelled: false, afterToolCall: false, unsent: message.id, messageIds: [message.id] }
    rt.turn = turn
    this.deps.emit({ type: 'turnStart', sessionId, threadId })

    let result: TurnResult
    let attachedTo: AgentConnection | undefined
    try {
      const res = await this.withAgent(session.agentId, async (conn) => {
        // A retry after sign-in starts a fresh agent message.
        turn.agentMessage = undefined
        turn.afterToolCall = false
        await this.attach(sessionId, conn)
        // Changes made elsewhere (the agent's CLI) come in before the prompt goes out.
        await this.ensureFresh(sessionId, conn, () => true)
        const acpSessionId = await this.attach(sessionId, conn)
        if (turn.cancelled) return { stopReason: 'cancelled' as const }
        attachedTo = conn
        const prompt = promptBlocks(wire, attachments, conn.promptCapabilities)
        const slot = this.slot(session.agentId)
        slot.activePrompts++
        turn.unsent = undefined
        try {
          return await conn.prompt(acpSessionId, prompt)
        } finally {
          slot.activePrompts--
        }
      })
      result = { stopReason: res.stopReason }
    } catch (err) {
      result = turn.cancelled ? { stopReason: 'cancelled' } : { error: errorMessage(err) }
    }
    // The turn changed the agent's copy: remember its updatedAt so it isn't taken for a change made elsewhere.
    if (attachedTo) await this.recordSynced(sessionId, attachedTo)
    rt.turn = undefined
    this.recordOutcome(turn, result)
    // A review's first pass (or a later review) lists findings: open their threads.
    if (threadId === null && session.review) await this.openFindings(sessionId, message.seq)
    // The queue moves on after a turn that ended normally or was cancelled (a cancel
    // stops only that turn). A failed or cut-short turn pauses it, so the user can
    // look before more is sent.
    let continues = false
    if (rt.queue.items.length > 0 && this.runtimes.get(sessionId) === rt) {
      continues = !result.error && (result.stopReason === 'end_turn' || result.stopReason === 'cancelled')
      if (rt.queue.paused !== !continues) this.setQueue(sessionId, { ...rt.queue, paused: !continues })
    }
    this.deps.emit({ type: 'turnEnd', sessionId, threadId, ...result, ...(continues ? { continues: true } : {}) })
    if (continues) this.drain(sessionId)
    return result
  }

  /** Marks the turn's user messages with how it ended (SPEC → Turn outcomes). */
  private recordOutcome(turn: Turn, result: TurnResult): void {
    const outcome: TurnOutcome =
      result.error
        ? 'failed'
        : result.stopReason === 'end_turn'
          ? 'completed'
          : result.stopReason === 'cancelled'
            ? 'cancelled'
            : 'failed'
    for (const id of turn.messageIds) {
      const message = this.deps.store.getMessage(id)
      if (!message) continue
      this.deps.store.setMessageOutcome(id, outcome)
      this.deps.emit({ type: 'message', message: { ...message, outcome } })
    }
  }

  private setQueue(sessionId: string, queue: MessageQueue): void {
    this.runtime(sessionId).queue = queue
    this.deps.emit({ type: 'queue', sessionId, queue })
  }

  /** Starts the next queued message if the session is idle and its queue isn't paused. */
  private drain(sessionId: string): void {
    const rt = this.runtimes.get(sessionId)
    if (!rt || rt.turn || rt.queue.paused) return
    const [next, ...rest] = rt.queue.items
    if (!next) return
    this.setQueue(sessionId, { items: rest, paused: false })
    this.runTurn(sessionId, next.text, next.threadId, next.attachments, next.fromThread ?? null).catch((err: unknown) =>
      this.notice(sessionId, next.threadId, `Couldn't send a queued message: ${errorMessage(err)}`)
    )
  }

  /** Replaces a queued message's text. */
  editQueued(sessionId: string, id: string, text: string): void {
    this.session(sessionId)
    const rt = this.runtime(sessionId)
    const item = rt.queue.items.find((q) => q.id === id)
    if (!item) throw new Error('That message has already been sent.')
    const trimmed = text.trim()
    if (!trimmed && item.attachments.length === 0) throw new Error("A queued message can't be empty. Remove it instead.")
    this.setQueue(sessionId, {
      ...rt.queue,
      items: rt.queue.items.map((q) => (q.id === id ? { ...q, text: trimmed } : q))
    })
  }

  removeQueued(sessionId: string, id: string): void {
    this.session(sessionId)
    const rt = this.runtime(sessionId)
    if (!rt.queue.items.some((q) => q.id === id)) throw new Error('That message has already been sent.')
    const items = rt.queue.items.filter((q) => q.id !== id)
    this.setQueue(sessionId, { items, paused: rt.queue.paused && items.length > 0 })
  }

  /** Sends the next queued message after the queue paused (once the running turn, if any, ends). */
  resumeQueue(sessionId: string): void {
    this.session(sessionId)
    const rt = this.runtime(sessionId)
    if (!rt.queue.paused) return
    this.setQueue(sessionId, { ...rt.queue, paused: false })
    this.drain(sessionId)
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

    // session/load replays the history: it is synced once the load ends (SPEC → Shared sessions).
    if (rt.loading) {
      if (isLogUpdate(u)) rt.replay?.push(u)
      return
    }
    // Conversation updates are recorded during a turn.
    const turn = rt.turn
    if (!turn) return
    const { store, emit } = this.deps

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
            ...(messageId !== undefined ? { acpMessageId: messageId } : {}),
            createdAt: this.now()
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
      case 'plan': {
        // Each update lists the whole plan: the turn's first one starts its checklist, later ones replace it.
        const entries = u.entries.map(planEntry)
        if (!turn.plan && entries.length === 0) return
        const plan: Plan = turn.plan
          ? { ...turn.plan, entries }
          : { id: randomUUID(), sessionId, seq: store.nextSeq(sessionId), threadId: turn.threadId, entries }
        store.upsertPlan(plan)
        if (!turn.plan) turn.afterToolCall = true
        turn.plan = plan
        emit({ type: 'plan', plan })
        return
      }
      default:
        // thoughts, etc.: not shown.
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

function isClear(text: string, attachments: Attachment[]): boolean {
  return text.trim() === '/clear' && attachments.length === 0
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind === 'listItem' && b.kind === 'listItem') {
    return a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i])
  }
  if (a.kind === 'selection' && b.kind === 'selection') return a.start === b.start && a.end === b.end
  if (a.kind === 'line' && b.kind === 'line') {
    return a.file === b.file && a.side === b.side && a.start === b.start && a.end === b.end
  }
  return false
}

/** Keeps only the anchor's known fields (it comes from the renderer). */
function normalizeAnchor(a: Anchor): Anchor {
  switch (a.kind) {
    case 'listItem':
      return { kind: 'listItem', path: [...a.path], text: a.text }
    case 'selection':
      return { kind: 'selection', start: a.start, end: a.end, text: a.text }
    case 'line':
      return { kind: 'line', file: a.file, side: a.side, start: a.start, end: a.end, text: a.text, lines: [...a.lines] }
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
        commands: [
          ...GLOSS_COMMANDS,
          ...u.availableCommands
            .filter((c) => !GLOSS_COMMANDS.some((g) => g.name === c.name))
            .map((c) => ({
              name: c.name,
              description: c.description,
              ...(c.input?.hint ? { hint: c.input.hint } : {})
            }))
        ]
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
      return configChoices(u.configOptions)
    default:
      return null
  }
}

/** The effort value Claude Code's adapter uses for "whatever Claude Code picks". */
export const DEFAULT_EFFORT = 'default'

/**
 * The effort to set: `wanted` when the model offers it, else, when the agent is on its
 * "default", the level its adapter recommends (medium, else the first). Null: leave it.
 */
export function concreteEffort(effort: ConfigChoice, wanted?: string): string | null {
  const levels = effort.options.map((o) => o.value).filter((v) => v !== DEFAULT_EFFORT)
  if (wanted && levels.includes(wanted)) return wanted
  if (effort.current !== DEFAULT_EFFORT) return null
  return levels.includes('medium') ? 'medium' : (levels[0] ?? null)
}

/** The agent's model and effort config options (categories "model" and "thought_level"). */
export function configChoices(options: acp.SessionConfigOption[]): Pick<SessionLive, 'model' | 'effort'> {
  return { model: selectOption(options, 'model'), effort: selectOption(options, 'thought_level') }
}

/** The agent's select config option of a category, flattened. */
function selectOption(options: acp.SessionConfigOption[], category: string): ConfigChoice | null {
  const o = options.find((x) => x.category === category && x.type === 'select')
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

function planEntry(e: acp.PlanEntry): PlanEntry {
  return { content: e.content, status: e.status, ...(e.priority ? { priority: e.priority } : {}) }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function seqOf(c: CachedEntry): number {
  return c.type === 'message' ? c.message.seq : c.type === 'toolCall' ? c.toolCall.messageSeq : c.plan.seq
}

/** The replay's status for a tool call Gloss saw unfinished (its turn was cut short), or null. */
function toolStatus(cached: ToolCall, replayed: Pick<ToolCall, 'status'>): string | null {
  const unfinished = cached.status === 'pending' || cached.status === 'in_progress'
  return unfinished && replayed.status !== cached.status ? replayed.status : null
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line
}
