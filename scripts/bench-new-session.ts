// No prompts or inference. Uses native agent credentials/config, but a scratch Gloss DB.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, release } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { AgentConnection, isResourceNotFound } from '../src/main/acp'
import { agentEnv, getAgentConfig } from '../src/main/agents'
import { Store } from '../src/main/db'
import { SessionManager } from '../src/main/sessions'
import type { McpServer } from '../src/shared/mcp'
import { projectSettings, type PermissionModeSetting } from '../src/shared/settings'

const { values } = parseArgs({ options: {
  agents: { type: 'string', default: 'claude,codex' },
  rounds: { type: 'string', default: '5' },
  cwd: { type: 'string', default: process.cwd() },
  output: { type: 'string', default: 'out/bench-new-session/results.json' },
  settings: { type: 'string' },
  'claude-creation-effort': { type: 'string' },
  'timeout-ms': { type: 'string', default: '90000' }
} })
const rounds = Number(values.rounds)
const timeoutMs = Number(values['timeout-ms'])
const agents = values.agents!.split(',')
if (!Number.isInteger(rounds) || rounds < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1 ||
    agents.some((id) => !['claude', 'codex'].includes(id))) throw new Error('Invalid rounds, timeout, or agents (claude,codex).')
const cwd = resolve(values.cwd!)
// Optional real Gloss settings, read only. Never include their contents in output.
const settings = values.settings ? JSON.parse(readFileSync(resolve(values.settings), 'utf8')) : {}
const servers: McpServer[] = settings.mcpServers ?? []
const projectMode = projectSettings(settings.projects ?? {}, cwd).permissionMode
const permissionMode: PermissionModeSetting = projectMode && projectMode !== 'inherit'
  ? projectMode : settings.permissionMode ?? 'bypass'
const scratch = mkdtempSync(join(tmpdir(), 'gloss-session-bench-'))
type Phase = { name: string; ms: number; ok: boolean }
type Sample = { agent: string; round: number; kind: 'cold' | 'warm'; ok: boolean; ms: number; phases: Phase[]; error?: string; attached?: boolean; mode?: string | null; effort?: string | null }
const samples: Sample[] = []
const cleanupWarnings: string[] = []
const versions = Object.fromEntries(agents.map((id) => {
  const entry = getAgentConfig(id).args[0]
  return [id, JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version]
}))
const output = resolve(values.output!)
mkdirSync(dirname(output), { recursive: true })
function save(): void {
  const summaries = agents.flatMap((agent) => ['cold', 'warm'].map((kind) => {
    const selected = samples.filter((s) => s.agent === agent && s.kind === kind)
    const times = selected.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b)
    const percentile = (p: number): number | null => times.length ? times[Math.max(0, Math.ceil(p * times.length) - 1)] : null
    return { agent, kind, successes: times.length, failures: selected.length - times.length,
      medianMs: percentile(0.5), p95Ms: percentile(0.95), minMs: times[0] ?? null, maxMs: times.at(-1) ?? null }
  }))
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(),
    scope: 'SessionManager.createSession through attached=true, then openSession snapshot; excludes renderer, IPC, inference and build time',
    coldDefinition: 'Fresh ACP adapter process and connection, first session. OS caches and native credentials remain warm.',
    warmDefinition: 'Next fresh session on the same connection, with the preceding empty session still attached.',
    environment: { platform: process.platform, os: release(), cpu: cpus()[0]?.model,
      node: process.versions.node, electron: process.versions.electron, adapters: versions,
      cwd, permissionMode, glossMcpServers: servers.length, explicitGlossSettings: Boolean(values.settings),
      claudeCreationEffort: values['claude-creation-effort'] ?? null },
    summaries, samples, cleanupWarnings }, null, 2) + '\n')
}

async function run(): Promise<void> {
  for (let round = 1; round <= rounds; round++) {
    // Alternate agent order to reduce systematic cache/order bias.
    for (const agent of round % 2 ? agents : [...agents].reverse()) {
      const store = new Store(join(scratch, `${agent}-${round}.db`))
      let current: Sample | undefined
      let connection: AgentConnection | undefined
      const createdIds: string[] = []
      const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const start = performance.now()
        let ok = false
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([fn(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs)
          })])
          ok = true
          return result
        } finally {
          clearTimeout(timer)
          current?.phases.push({ name, ms: performance.now() - start, ok })
        }
      }
      const manager = new SessionManager({
        store, getAgentConfig: (id) => {
          const config = getAgentConfig(id)
          if (id !== 'claude' || !values['claude-creation-effort']) return config
          return { ...config, sessionMeta: (instructions) => {
            const meta = config.sessionMeta!(instructions)
            return { ...meta, new: { ...meta.new, claudeCode: { options: { effort: values['claude-creation-effort'] } } } }
          } }
        }, agentEnv, mcpServers: () => servers, permissionMode: () => permissionMode,
        runInTerminal: async () => { throw new Error('Benchmark never starts sign-in') },
        emit: (event) => {
          if (event.type === 'authRequired') throw new Error('Agent requires sign-in; sign in outside the benchmark first')
        },
        connect: async (config, env, handlers) => {
          connection = await timed('connect (spawn + initialize)', () => AgentConnection.start(
            { ...config, startupTimeoutMs: timeoutMs }, env, { ...handlers, onStderr: () => {} }))
          return new Proxy(connection, {
            get(target, key) {
              const value = Reflect.get(target, key)
              if (typeof value !== 'function') return value
              if (['newSession', 'setMode', 'setConfigOption'].includes(String(key))) {
                return (...args: unknown[]) => timed(key === 'setConfigOption' ? `setConfigOption (${args[1]})` : String(key), async () => {
                  const response = await value.apply(target, args)
                  if (key === 'newSession') createdIds.push(response.sessionId)
                  return response
                })
              }
              // The benchmark must never issue inference requests.
              if (['prompt', 'steer'].includes(String(key))) return () => { throw new Error('Inference disabled') }
              return value.bind(target)
            }
          })
        }
      })
      try {
        for (const kind of ['cold', 'warm'] as const) {
          current = { agent, round, kind, ok: false, ms: 0, phases: [] }
          samples.push(current)
          const start = performance.now()
          let succeeded = false
          try {
            const session = await manager.createSession(cwd, agent)
            const openStart = performance.now()
            const view = manager.openSession(session.id)
            current.phases.push({ name: 'openSession snapshot', ms: performance.now() - openStart, ok: true })
            current.attached = view.live.attached
            current.mode = view.live.modes?.current ?? null
            current.effort = view.live.effort?.current ?? null
            if (!view.live.attached) throw new Error('Session did not become attached')
            current.ok = true
            succeeded = true
          } catch (error) {
            // Do not print agent errors which may include credentials or native config.
            current.error = error instanceof Error && /timed out|sign-in|attached/.test(error.message)
              ? error.message : 'Agent request failed (native diagnostics suppressed)'
          } finally {
            current.ms = performance.now() - start
            console.log(`${agent} ${kind} ${round}/${rounds}: ${current.ok ? `${current.ms.toFixed(1)} ms` : current.error}`)
            current = undefined // Cleanup is outside the measured interval.
            save()
          }
          if (!succeeded) break // A failed cold start cannot produce a valid warm sample.
        }
      } finally {
        if (connection) for (const sessionId of createdIds) {
          try {
            if (connection.canCloseSessions) await timed('closeSession', () => connection!.closeSession(sessionId))
            // Empty Claude sessions have no transcript. Verify absence instead of
            // asking its SDK to delete a file that was never created.
            if (agent === 'claude' && connection.canListSessions) {
              const listed = await timed('listSessions (cleanup)', () => connection!.listSessions(cwd))
              if (!listed.some((session) => session.sessionId === sessionId)) continue
            }
            if (connection.canDeleteSessions) await timed('deleteSession', () => connection!.deleteSession(sessionId))
            else cleanupWarnings.push(`${agent} round ${round}: native deletion unsupported`)
          } catch (error) {
            if (!isResourceNotFound(error)) cleanupWarnings.push(`${agent} round ${round}: empty native session deletion failed`)
          } finally {
            try {
              if (connection.canCloseSessions) await timed('closeSession', () => connection!.closeSession(sessionId))
            } catch { cleanupWarnings.push(`${agent} round ${round}: empty native session close failed`) }
          }
        }
        await manager.dispose()
        store.close()
      }
    }
  }
}
run().then(() => {
  console.log(`Results: ${output}`)
  if (samples.some((s) => !s.ok)) process.exitCode = 1
}).catch(() => {
  console.error('Benchmark failed; inspect partial results. Native diagnostics suppressed.')
  process.exitCode = 1
}).finally(() => {
  save()
  const cleanupPath = resolve(scratch)
  if (!cleanupPath.startsWith(resolve(tmpdir()) + sep) || !basename(cleanupPath).startsWith('gloss-session-bench-')) {
    throw new Error('Refusing cleanup outside benchmark temporary directory')
  }
  rmSync(cleanupPath, { recursive: true, force: true })
})
