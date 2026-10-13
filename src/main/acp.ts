// One ACP connection to one agent (a spawned process, or an in-process agent in tests).
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentConfig } from './agents'

export type AgentHandlers = {
  onUpdate(notification: acp.SessionNotification): void
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
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

export class AgentConnection {
  private closed = false

  private constructor(
    private readonly conn: acp.ClientConnection,
    readonly init: acp.InitializeResponse,
    private readonly child?: ChildProcess
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
    createInterface({ input: child.stderr! }).on('line', handlers.onStderr)
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
      throw err
    }
    return AgentConnection.open(stream, handlers, child)
  }

  /** Connects to an ACP stream or an in-process agent app and initializes. */
  static async open(
    target: acp.Stream | acp.AgentApp,
    handlers: AgentHandlers,
    child?: ChildProcess
  ): Promise<AgentConnection> {
    const app = acp
      .client({ name: 'gloss' })
      .onNotification(acp.methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        handlers.onPermission(ctx.params)
      )
    const conn = target instanceof acp.AgentApp ? app.connect(target) : app.connect(target)
    child?.once('exit', (code, signal) =>
      conn.close(new Error(`Agent process exited (code ${code}, signal ${signal})`))
    )
    try {
      // No fs or terminal client capabilities in v1: the agent uses its own tools.
      // auth.terminal: we can run terminal sign-in methods (SPEC → Authentication).
      const init = await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
        clientInfo: { name: 'gloss', title: 'Gloss', version: '0.1.0' }
      })
      const connection = new AgentConnection(conn, init, child)
      const onClosed = (): void => {
        connection.closed = true
        handlers.onClosed()
      }
      conn.closed.then(onClosed, onClosed)
      return connection
    } catch (err) {
      conn.close(err)
      child?.kill()
      throw err
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

  get promptCapabilities(): acp.PromptCapabilities {
    return this.init.agentCapabilities?.promptCapabilities ?? {}
  }

  /** The agent's sessions in `cwd`, following pages up to `maxPages`. */
  async listSessions(cwd: string, maxPages = 10): Promise<acp.SessionInfo[]> {
    const sessions: acp.SessionInfo[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < maxPages; page++) {
      const res = await this.conn.agent.request(acp.methods.agent.session.list, { cwd, cursor })
      sessions.push(...res.sessions)
      cursor = res.nextCursor
      if (!cursor) break
    }
    return sessions
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.conn.agent.request(acp.methods.agent.session.delete, { sessionId })
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value })
  }

  newSession(cwd: string): Promise<acp.NewSessionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
  }

  loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: []
    })
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId })
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt })
  }

  cancel(sessionId: string): Promise<void> {
    return this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  async authenticate(methodId: string): Promise<void> {
    await this.conn.agent.request(acp.methods.agent.authenticate, { methodId })
  }

  dispose(): void {
    this.conn.close()
    if (this.child && this.child.exitCode === null) this.child.kill()
  }
}
