// One ACP connection to one spawned agent process.
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
  onExit(code: number | null, signal: NodeJS.Signals | null): void
}

export class AgentConnection {
  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: acp.ClientConnection,
    readonly init: acp.InitializeResponse
  ) {}

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
    const conn = acp
      .client({ name: 'gloss' })
      .onNotification(acp.methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        handlers.onPermission(ctx.params)
      )
      .connect(stream)

    child.once('exit', (code, signal) => {
      conn.close(new Error(`Agent process exited (code ${code}, signal ${signal})`))
      handlers.onExit(code, signal)
    })

    try {
      await spawned
      // No fs or terminal client capabilities in v1: the agent uses its own tools.
      const init = await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'gloss', title: 'Gloss', version: '0.1.0' }
      })
      return new AgentConnection(child, conn, init)
    } catch (err) {
      conn.close(err)
      child.kill()
      throw err
    }
  }

  newSession(cwd: string): Promise<acp.NewSessionResponse> {
    return this.conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
  }

  prompt(sessionId: string, text: string): Promise<acp.PromptResponse> {
    return this.conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }]
    })
  }

  cancel(sessionId: string): Promise<void> {
    return this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  dispose(): void {
    this.conn.close()
    if (this.child.exitCode === null) this.child.kill()
  }
}
