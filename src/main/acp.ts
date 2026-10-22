// One ACP connection to one agent (a spawned process, or an in-process agent in tests).
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentConfig } from './agents'

export type AgentHandlers = {
  onUpdate(notification: acp.SessionNotification): void
  /** `signal` aborts when the agent withdraws the request ($/cancel_request) or the connection closes. */
  onPermission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>
  /** A form elicitation (SPEC → Questions and approvals). Absent: Gloss doesn't advertise elicitation. */
  onElicitation?(request: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>
  /** A line the agent wrote to stderr. */
  onStderr(line: string): void
  /** The connection closed (agent exited, or dispose() was called). */
  onClosed(): void
}

/** ACP's auth_required error code. */
const AUTH_REQUIRED = acp.RequestError.authRequired().code

export function isAuthRequired(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === AUTH_REQUIRED
  )
}

/** ACP's resource_not_found error code. */
const RESOURCE_NOT_FOUND = acp.RequestError.resourceNotFound().code

export function isResourceNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === RESOURCE_NOT_FOUND
  )
}

/**
 * The Codex adapter refuses session/load while another Codex client (the app,
 * the CLI, an IDE) holds the session: invalid_request with this reason.
 */
export function isSessionInUse(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const data = (err as { data?: unknown }).data
  return typeof data === 'object' && data !== null && (data as { reason?: unknown }).reason === 'thread_active_writer'
}

/**
 * The Claude adapter's steering extension: injects a message into the running
 * turn. Advertised as `_meta.steering.supported` in the initialize response.
 */
const STEER_METHOD = '_session/steering'

/**
 * `injected`: the message joined the running turn, whose output now answers it.
 * `promptRequired`: no turn was running, so nothing was sent.
 */
export type SteerOutcome = 'injected' | 'promptRequired'

export class AgentConnection {
  private closed = false

  private constructor(
    private readonly conn: acp.ClientConnection,
    readonly init: acp.InitializeResponse,
    private readonly child?: ChildProcess,
    private readonly privateDiagnostics = false
  ) {}

  /** Spawns the agent's ACP entrypoint and initializes the connection. */
  static async start(
    config: AgentConfig,
    env: NodeJS.ProcessEnv,
    handlers: AgentHandlers
  ): Promise<AgentConnection> {
    const child = spawn(config.command, config.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    createInterface({ input: child.stderr! }).on('line', config.privateDiagnostics ? () => {} : handlers.onStderr)
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
    child.once('exit', (code, signal) => {
      handlers.onStderr(`[agent exited: code ${code}, signal ${signal}]`)
    })
    try {
      await spawned
    } catch (err) {
      child.kill()
      // The original cause can contain credentials in arguments or native config.
      // eslint-disable-next-line preserve-caught-error
      if (config.privateDiagnostics) throw new Error('Could not start the custom agent. Check that its executable is installed and accessible.')
      throw err
    }
    return AgentConnection.open(stream, handlers, child, config.startupTimeoutMs, config.privateDiagnostics)
  }

  /** Connects to an ACP stream or an in-process agent app and initializes. */
  static async open(
    target: acp.Stream | acp.AgentApp,
    handlers: AgentHandlers,
    child?: ChildProcess,
    timeoutMs?: number,
    privateDiagnostics = false
  ): Promise<AgentConnection> {
    const app = acp
      .client({ name: 'gloss' })
      .onNotification(acp.methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        handlers.onPermission(ctx.params, ctx.signal)
      )
    const onElicitation = handlers.onElicitation
    if (onElicitation) {
      app.onRequest(acp.methods.client.elicitation.create, (ctx) => onElicitation(ctx.params, ctx.signal))
    }
    const conn = target instanceof acp.AgentApp ? app.connect(target) : app.connect(target)
    child?.once('exit', (code, signal) =>
      conn.close(new Error(`Agent process exited (code ${code}, signal ${signal})`))
    )
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      // No fs or terminal client capabilities in v1: the agent uses its own tools.
      // auth.terminal: we can run terminal sign-in methods (SPEC → Authentication).
      // elicitation.form: we show the agent's questions (SPEC → Questions and approvals).
      const request = conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true }, ...(onElicitation ? { elicitation: { form: {} } } : {}) },
        clientInfo: { name: 'gloss', title: 'Gloss', version: '0.1.0' }
      })
      const init = timeoutMs ? await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Agent initialization timed out. Check the executable and its configuration.')), timeoutMs)
        })
      ]) : await request
      if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version ${init.protocolVersion}`)
      const connection = new AgentConnection(conn, init, child, privateDiagnostics)
      const onClosed = (): void => {
        connection.closed = true
        handlers.onClosed()
      }
      conn.closed.then(onClosed, onClosed)
      return connection
    } catch (err) {
      conn.close(err)
      child?.kill()
      if (privateDiagnostics) {
        const message = err instanceof Error ? err.message : ''
        // eslint-disable-next-line preserve-caught-error
        if (!(err instanceof acp.RequestError) && (message === 'Agent initialization timed out. Check the executable and its configuration.' || /^Unsupported ACP protocol version \d+$/.test(message))) throw new Error(message)
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Could not start the custom agent. ACP initialization failed or the process exited. Check its executable, arguments and native configuration.')
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Keep ACP error codes for sign-in and recovery, but never expose external payloads. */
  private async guard<T>(pending: Promise<T>): Promise<T> {
    try { return await pending } catch (err) {
      if (!this.privateDiagnostics) throw err
      const message = 'Custom agent request failed. Check its native provider configuration and model server, then retry.'
      if (err instanceof acp.RequestError) throw new acp.RequestError(err.code, message)
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message)
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  get authMethods(): acp.AuthMethod[] {
    return this.init.authMethods ?? []
  }

  get canLoadSession(): boolean {
    return this.init.agentCapabilities?.loadSession === true
  }

  get canListSessions(): boolean {
    return this.init.agentCapabilities?.sessionCapabilities?.list != null
  }

  get canDeleteSessions(): boolean {
    return this.init.agentCapabilities?.sessionCapabilities?.delete != null
  }

  get canCloseSessions(): boolean {
    return this.init.agentCapabilities?.sessionCapabilities?.close != null
  }

  get canSteer(): boolean {
    const steering = (this.init._meta as { steering?: { supported?: unknown } } | null | undefined)?.steering
    return steering?.supported === true
  }

  get promptCapabilities(): acp.PromptCapabilities {
    return this.init.agentCapabilities?.promptCapabilities ?? {}
  }

  /** Stdio is required by ACP v1. HTTP and SSE require advertised support. */
  validateMcp(servers: acp.McpServer[]): void {
    for (const server of servers) {
      if ('type' in server && (server.type === 'acp' || this.init.agentCapabilities?.mcpCapabilities?.[server.type] !== true)) {
        throw new Error(`This agent does not support ${server.type.toUpperCase()} MCP transport (${server.name}). Change the global MCP settings or choose another agent.`)
      }
    }
  }

  /** The agent's sessions in `cwd`, following pages up to `maxPages`. */
  async listSessions(cwd: string, maxPages = 10): Promise<acp.SessionInfo[]> {
    const sessions: acp.SessionInfo[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < maxPages; page++) {
      const res = await this.guard(this.conn.agent.request(acp.methods.agent.session.list, { cwd, cursor }))
      sessions.push(...res.sessions)
      cursor = res.nextCursor
      if (!cursor) break
    }
    return sessions
  }

  /** One of the agent's sessions in `cwd` (session/list, newest first), or undefined if it isn't in the first `maxPages`. */
  async findSession(cwd: string, sessionId: string, maxPages = 10): Promise<acp.SessionInfo | undefined> {
    let cursor: string | null | undefined
    for (let page = 0; page < maxPages; page++) {
      const res = await this.guard(this.conn.agent.request(acp.methods.agent.session.list, { cwd, cursor }))
      const found = res.sessions.find((s) => s.sessionId === sessionId)
      if (found) return found
      cursor = res.nextCursor
      if (!cursor) break
    }
    return undefined
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.guard(this.conn.agent.request(acp.methods.agent.session.delete, { sessionId }))
  }

  /** Stops the agent's live copy of the session; a later session/load starts it again from its saved history. */
  async closeSession(sessionId: string): Promise<void> {
    await this.guard(this.conn.agent.request(acp.methods.agent.session.close, { sessionId }))
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
    return this.guard(this.conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value }))
  }

  newSession(cwd: string, meta?: Record<string, unknown>, mcpServers: acp.McpServer[] = []): Promise<acp.NewSessionResponse> {
    this.validateMcp(mcpServers)
    return this.guard(this.conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }))
  }

  loadSession(sessionId: string, cwd: string, meta?: Record<string, unknown>, mcpServers: acp.McpServer[] = []): Promise<acp.LoadSessionResponse> {
    this.validateMcp(mcpServers)
    return this.guard(this.conn.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers,
      ...(meta ? { _meta: meta } : {})
    }))
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.guard(this.conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId }))
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.guard(this.conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt }))
  }

  /** Injects a message into the session's running turn (see STEER_METHOD). */
  async steer(sessionId: string, prompt: acp.ContentBlock[]): Promise<SteerOutcome> {
    // promptRequired: if the turn already ended, the adapter sends nothing
    // instead of starting a turn Gloss doesn't know about.
    const res = await this.guard(this.conn.agent.request<{ outcome?: unknown }>(STEER_METHOD, {
      sessionId,
      prompt,
      _meta: { steering: { idleBehavior: 'promptRequired' } }
    }))
    if (res.outcome === 'injected' || res.outcome === 'promptRequired') return res.outcome
    throw new Error(`Unexpected steering outcome: ${String(res.outcome)}`)
  }

  cancel(sessionId: string): Promise<void> {
    return this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  async authenticate(methodId: string): Promise<void> {
    await this.guard(this.conn.agent.request(acp.methods.agent.authenticate, { methodId }))
  }

  dispose(): void {
    this.conn.close()
    if (this.child && this.child.exitCode === null) this.child.kill()
  }
}
