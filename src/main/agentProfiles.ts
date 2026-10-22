import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileError, type AgentProfile } from '../shared/agentProfiles'
import type { AgentProfileStatus } from '../shared/ipc'
import { AGENT_INSTRUCTIONS } from '../shared/wire'
import { AgentConnection } from './acp'
import { agentEnv, type AgentConfig } from './agents'

export class AgentProfileSupport {
  constructor(private readonly dataDir: string, private readonly connect = AgentConnection.start) {}

  config(profile: AgentProfile, base: NodeJS.ProcessEnv = process.env): AgentConfig {
    const error = profileError(profile)
    if (error) throw new Error(error)
    if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(profile.command)) throw new Error('Choose a native executable, not a command or PowerShell wrapper.')
    const env: Record<string, string> = {}
    for (const [name, reference] of Object.entries(profile.env)) {
      const value = base[reference]
      if (typeof value !== 'string') throw new Error(`Environment variable ${reference} is missing. Set it before starting Gloss.`)
      env[name] = value
    }
    mkdirSync(this.dataDir, { recursive: true })
    const file = join(this.dataDir, `${profile.id.replace(':', '-')}-instructions.md`)
    const instructions = `${AGENT_INSTRUCTIONS}\n\nTags of the form [re: path:line "<quote>"] (or path:start-end) refer to lines of a diff under review. Paths are relative to the repository root; (old) means removed lines in the base version. Answer about those lines like other thread anchors.\n`
    let previous: string | undefined
    try { previous = readFileSync(file, 'utf8') } catch { /* First setup. */ }
    if (previous !== instructions) writeFileSync(file, instructions, 'utf8')
    if (profile.instructionsEnv) env[profile.instructionsEnv] = file
    return {
      id: profile.id, name: profile.name, command: profile.command.trim(),
      args: profile.args.map((arg) => arg.replaceAll('{instructions}', file)), env,
      startupTimeoutMs: 15000, privateDiagnostics: true
    }
  }

  async check(profile: AgentProfile): Promise<AgentProfileStatus> {
    let conn: AgentConnection | undefined
    try {
      const config = this.config(profile)
      conn = await this.connect(config, agentEnv(config), {
        onUpdate() {}, onStderr() {}, onClosed() {},
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } })
      })
      return {
        available: true, version: conn.init.agentInfo?.version ?? null, error: null,
        capabilities: {
          resume: conn.canLoadSession, discovery: conn.canListSessions, steering: conn.canSteer,
          images: conn.promptCapabilities.image === true, context: conn.promptCapabilities.embeddedContext === true
        }
      }
    } catch (err) {
      // Config errors are our own validation; protocol and process payloads can contain secrets.
      const message = err instanceof Error ? err.message : ''
      const safe = /^(Environment variable|Choose a native|Agent initialization|Unsupported ACP|Could not start|Custom agent request)/.test(message)
      return { available: false, version: null, error: safe ? message : 'Could not connect to this ACP agent. Check its executable, arguments and native configuration.', capabilities: null }
    } finally {
      conn?.dispose()
    }
  }
}
