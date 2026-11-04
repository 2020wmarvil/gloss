// Claude Code and Codex are user-installed: Gloss finds their CLIs and runs its bundled
// adapters against them (SPEC → Shipping). The adapters need a minimum CLI version.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OpenCodeStatus } from '../shared/ipc'

export type CliKind = 'claude' | 'codex'
export type CliStatus = OpenCodeStatus

type CliInfo = {
  name: string
  command: string
  /** The oldest CLI the bundled adapter was checked against. Raise it with the adapter. */
  minVersion: string
  install: string
  update: string
  setting: string
}

export const CLIS: Record<CliKind, CliInfo> = {
  claude: {
    name: 'Claude Code', command: 'claude', minVersion: '2.1.316',
    install: 'Install Claude Code (https://code.claude.com)',
    update: 'Run `claude update`',
    setting: 'claudeExecutable'
  },
  codex: {
    name: 'Codex', command: 'codex', minVersion: '0.165.0',
    install: 'Install the Codex CLI (`npm install -g @openai/codex`) or the Codex app',
    update: 'Run `npm install -g @openai/codex@latest`, or update the Codex app',
    setting: 'codexExecutable'
  }
}

export type FindOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  home?: string
  exists?: (path: string) => boolean
  /** Install folders of the Codex app (Windows), newest last. */
  codexApps?: () => Promise<string[]>
}

function executableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/** The Codex app's package folders, from the per-user package repository in the registry. */
function codexAppFolders(): Promise<string[]> {
  const key = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/f', 'OpenAI.Codex_', '/k', '/s', '/v', 'PackageRootFolder'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([])
      const folders = [...stdout.matchAll(/PackageRootFolder\s+REG_SZ\s+(.+)/g)].map((m) => m[1].trim())
      resolve(folders.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
    })
  })
}

/**
 * Finds a CLI's native executable: the configured path, else PATH, else where its installers
 * put it. On Windows an npm install puts only a `.cmd` shim on PATH, which Node can't spawn
 * directly, so the package's own binary behind it is used.
 */
export async function findCli(kind: CliKind, configured = '', options: FindOptions = {}): Promise<string> {
  const { env = process.env, platform = process.platform, arch = process.arch, home = homedir(), exists = executableFile } = options
  const info = CLIS[kind]
  const sep = platform === 'win32' ? '\\' : '/'
  const path = (...parts: string[]): string => platform === process.platform ? join(...parts) : parts.join(sep)
  if (configured.trim()) {
    const command = configured.trim()
    if (platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)) {
      throw new Error(`Set ${info.setting} to the native ${info.command}.exe, not a .cmd, .bat or PowerShell wrapper.`)
    }
    if (exists(command)) return command
    throw new Error(`${info.name} wasn't found at ${command}. Fix ${info.setting} in the settings file, or clear it to find an installed copy.`)
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map((d) => d.replace(/^"|"$/g, '')).filter(Boolean)
  const exe = platform === 'win32' ? `${info.command}.exe` : info.command
  for (const dir of dirs) {
    const found = path(dir, exe)
    if (exists(found)) return found
  }
  if (platform === 'win32') {
    const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    for (const dir of dirs) {
      if (!exists(path(dir, `${info.command}.cmd`))) continue
      const behind = kind === 'claude'
        ? [path(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
        : [
          path(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
          path(dir, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe')
        ]
      const found = behind.find(exists)
      if (found) return found
    }
  }
  // Claude Code's native installer puts it in ~/.local/bin, which may not be on PATH.
  if (kind === 'claude') {
    const found = path(home, '.local', 'bin', exe)
    if (exists(found)) return found
  }
  // The Codex desktop app ships the CLI in its versioned package folder, off PATH.
  if (kind === 'codex' && platform === 'win32') {
    for (const folder of [...await (options.codexApps ?? codexAppFolders)()].reverse()) {
      const found = path(folder, 'app', 'resources', 'codex.exe')
      if (exists(found)) return found
    }
  }
  throw new Error(`${info.name} wasn't found. ${info.install}, or set its path as ${info.setting} in the settings file.`)
}

/** `[major, minor, patch]` from a version string like "2.1.233 (Claude Code)" or "codex-cli 0.166.0-alpha.5". */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function versionAtLeast(version: [number, number, number], min: string): boolean {
  const floor = parseVersion(min)!
  for (let i = 0; i < 3; i++) if (version[i] !== floor[i]) return version[i] > floor[i]
  return true
}

function versionOutput(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--version'], { windowsHide: true, timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
  })
}

type Probe = { find: typeof findCli; version: (executable: string) => Promise<string> }

/** Finds and version-checks the installed CLIs, remembering the answer for 30 seconds. */
export class AgentClis {
  private cached = new Map<CliKind, { key: string; at: number; pending: Promise<CliStatus>; status?: CliStatus }>()
  /** Called when a check finishes, so the agents list can show the result. */
  changed?: (kind: CliKind) => void

  constructor(private readonly probe: Probe = { find: findCli, version: versionOutput }, private readonly now = Date.now) {}

  check(kind: CliKind, configured = '', force = false): Promise<CliStatus> {
    const cached = this.cached.get(kind)
    if (!force && cached?.key === configured && this.now() - cached.at < 30_000) return cached.pending
    const entry: { key: string; at: number; pending: Promise<CliStatus>; status?: CliStatus } = {
      key: configured, at: this.now(), pending: this.run(kind, configured), status: cached?.key === configured ? cached.status : undefined
    }
    this.cached.set(kind, entry)
    void entry.pending.then((status) => {
      if (this.cached.get(kind) !== entry) return
      entry.status = status
      this.changed?.(kind)
    })
    return entry.pending
  }

  /** The last finished check, starting a new one when it's stale. Undefined until one finishes. */
  known(kind: CliKind, configured = ''): CliStatus | undefined {
    void this.check(kind, configured)
    const cached = this.cached.get(kind)
    return cached?.key === configured ? cached.status : undefined
  }

  /** The executable to run, or an error saying how to install or update it. */
  async resolve(kind: CliKind, configured = ''): Promise<string> {
    let status = await this.check(kind, configured)
    // Installed or updated since the last check: look again before failing.
    if (!status.available) status = await this.check(kind, configured, true)
    if (!status.available) throw new Error(status.error ?? `${CLIS[kind].name} isn't available.`)
    return status.executable!
  }

  private async run(kind: CliKind, configured: string): Promise<CliStatus> {
    const info = CLIS[kind]
    let executable: string
    try {
      executable = await this.probe.find(kind, configured)
    } catch (err) {
      return { available: false, executable: null, version: null, error: (err as Error).message }
    }
    let output: string
    try {
      output = await this.probe.version(executable)
    } catch {
      return { available: false, executable, version: null, error: `${info.name} at ${executable} didn't start. ${info.update}, or reinstall it.` }
    }
    const version = parseVersion(output)
    if (!version) return { available: false, executable, version: null, error: `Couldn't read the version of ${info.name} at ${executable}.` }
    const text = version.join('.')
    if (!versionAtLeast(version, info.minVersion)) {
      return { available: false, executable, version: text, error: `${info.name} ${text} is too old for Gloss (it needs ${info.minVersion} or newer). ${info.update}.` }
    }
    return { available: true, executable, version: text, error: null }
  }
}
