// OpenCode v2 is user-installed. Gloss supplies only its own instructions and ACP transport.
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { AGENT_INSTRUCTIONS } from '../shared/wire'
import type { OpenCodeStatus } from '../shared/ipc'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig, type AgentConfig } from './agents'

export const OPENCODE_INSTRUCTIONS = `${AGENT_INSTRUCTIONS}

Tags of the form \`[re: path:line "<quote>"]\` (or \`path:start-end\`) refer to lines of a diff under review. Paths are relative to the repository root; \`(old)\` means the base's version of removed lines. Answer about those lines in the same way as other thread anchors.

Your harness is OpenCode. A skill description mentioning Codex or another product does not identify the model serving this session. Do not infer your model identity from skill descriptions. If you cannot verify the configured model, say so.
`

function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/** Native binaries only: Node cannot directly spawn Windows .cmd/.bat shims. */
export function findOpenCodeExecutable(
  configured = '', env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform
): string {
  const names = platform === 'win32' ? ['opencode.exe', 'opencode-cli.exe'] : ['opencode']
  const search = (name: string): string | undefined => {
    const path = env.PATH ?? env.Path ?? ''
    for (const dir of path.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name)
      if (executableFile(candidate)) return candidate
    }
    return undefined
  }
  if (configured.trim()) {
    const command = configured.trim()
    if (platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)) {
      throw new Error('Choose the native OpenCode .exe, rather than a .cmd, .bat or PowerShell wrapper.')
    }
    const resolved = /[/\\]/.test(command) ? command : search(command)
    if (resolved && executableFile(resolved)) return resolved
    throw new Error('OpenCode executable was not found. Set its path in Settings and test the connection.')
  }
  for (const name of names) {
    const found = search(name)
    if (found) return found
  }
  // OpenCode Desktop installs versioned native CLIs without necessarily adding PATH entries.
  if (platform === 'win32' && env.APPDATA) {
    const dir = join(env.APPDATA, 'ai.opencode.desktop', 'cli')
    try {
      const versions = readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const version of versions) {
        const found = join(dir, version, 'opencode-cli.exe')
        if (executableFile(found)) return found
      }
    } catch { /* The desktop app is optional. */ }
  }
  throw new Error('OpenCode was not found. Install OpenCode v2, or set its native executable path in Settings.')
}

/** Add our file to the native configuration without replacing providers, models or existing instructions. */
export function openCodeConfigContent(instructionFile: string, existing?: string): string {
  let raw: Record<string, unknown> = {}
  if (existing?.trim()) {
    try {
      const value: unknown = JSON.parse(existing)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      raw = value as Record<string, unknown>
    } catch {
      throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object so Gloss can append its instructions. Native config files can still use JSONC.')
    }
  }
  if (raw.instructions !== undefined && (!Array.isArray(raw.instructions) || raw.instructions.some((v) => typeof v !== 'string'))) {
    throw new Error('OPENCODE_CONFIG_CONTENT.instructions must be an array of paths.')
  }
  return JSON.stringify({ ...raw, instructions: [...new Set([...(raw.instructions as string[] | undefined ?? []), instructionFile])] })
}

type Connect = typeof AgentConnection.start

export class OpenCodeSupport {
  private cached?: { key: string; at: number; pending: Promise<OpenCodeStatus> }

  constructor(private readonly dataDir: string, private readonly connect: Connect = AgentConnection.start) {}

  config(configured = ''): AgentConfig {
    const command = findOpenCodeExecutable(configured)
    mkdirSync(this.dataDir, { recursive: true })
    const file = join(this.dataDir, 'opencode-instructions.md')
    let previous: string | undefined
    try { previous = readFileSync(file, 'utf8') } catch { /* First run. */ }
    if (previous !== OPENCODE_INSTRUCTIONS) writeFileSync(file, OPENCODE_INSTRUCTIONS, 'utf8')
    return {
      ...getAgentConfig('opencode'), command,
      env: { OPENCODE_CONFIG_CONTENT: openCodeConfigContent(file, process.env.OPENCODE_CONFIG_CONTENT) }
    }
  }

  check(configured = '', force = false): Promise<OpenCodeStatus> {
    if (!force && this.cached?.key === configured && Date.now() - this.cached.at < 30_000) return this.cached.pending
    const pending = this.probe(configured)
    this.cached = { key: configured, at: Date.now(), pending }
    return pending
  }

  private async probe(configured: string): Promise<OpenCodeStatus> {
    let config: AgentConfig | undefined
    let conn: AgentConnection | undefined
    try {
      config = this.config(configured)
      conn = await this.connect(config, agentEnv(config), {
        onUpdate() {}, onStderr() {}, onClosed() {},
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } })
      })
      const version = conn.init.agentInfo?.version ?? ''
      const major = /^(?:v)?(\d+)\./.exec(version)?.[1]
      if (conn.init.agentInfo?.name.toLowerCase() !== 'opencode' || !major || Number(major) < 2) {
        throw new Error('This integration requires OpenCode v2 or newer. Update OpenCode or choose its v2 executable.')
      }
      return { available: true, executable: config.command, version, error: null }
    } catch (err) {
      // Never expose raw initialization payloads, which may contain native configuration secrets.
      const known = err instanceof Error && /^(OpenCode|Choose the native|This integration|OPENCODE_CONFIG_CONTENT|Agent initialization|Unsupported ACP)/.test(err.message)
      return {
        available: false, executable: config?.command ?? null, version: null,
        error: known ? (err as Error).message : 'Could not connect to OpenCode. Check the executable and native configuration, then test again.'
      }
    } finally {
      conn?.dispose()
    }
  }
}
