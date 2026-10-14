// Read the same account limits as Codex's /status without opening a thread or turn.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { PlanUsage } from '../shared/types'

type CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
type Snapshot = {
  limitId?: string | null
  limitName?: string | null
  planType?: string | null
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
}
export type CodexUsageResponse = {
  rateLimits: Snapshot
  rateLimitsByLimitId?: Record<string, Snapshot | undefined> | null
}

export function codexPlanUsage(response: CodexUsageResponse): PlanUsage {
  let buckets = Object.entries(response.rateLimitsByLimitId ?? {}).filter(
    (entry): entry is [string, Snapshot] => entry[1] !== undefined
  )
  if (!buckets.length) buckets = [[response.rateLimits.limitId ?? 'codex', response.rateLimits]]
  const limits: PlanUsage['limits'] = []
  for (const [id, bucket] of buckets) {
    const prefix = buckets.length > 1 || id !== 'codex' ? `${bucket.limitName ?? id} · ` : ''
    for (const [kind, window] of [['Primary', bucket.primary], ['Secondary', bucket.secondary]] as const) {
      if (!window || !Number.isFinite(window.usedPercent)) continue
      const mins = window.windowDurationMins
      const label = mins === 10080 ? 'Weekly limit'
        : mins === null ? `${kind} limit`
          : mins % 60 === 0 ? `${mins / 60}-hour limit` : `${mins}-minute limit`
      limits.push({ label: prefix + label, percent: window.usedPercent,
        resetsAt: window.resetsAt == null ? null : window.resetsAt * 1000 })
    }
  }
  const plan = buckets.find(([, bucket]) => bucket.planType)?.[1].planType
  return { plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null,
    available: true, limits, extraUsage: null }
}

/** Short-lived stdio app-server. Only initialization and account reads, never session writes. */
export function fetchCodexUsage(cwd: string): Promise<PlanUsage> {
  // Resolve relative to the adapter so we always use the Codex version it installed.
  const cli = require.resolve('@openai/codex/bin/codex.js', {
    paths: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')]
  })
  const child = spawn(process.execPath, [cli, 'app-server'], {
    cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'pipe'
  })
  const lines = createInterface({ input: child.stdout })
  // Drain diagnostics, but don't expose account details or tokens in UI errors.
  child.stderr.resume()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, usage?: PlanUsage): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      // EOF lets the native process exit too (killing its JS launcher alone doesn't on Windows).
      const killTimer = setTimeout(() => child.kill(), 1000)
      killTimer.unref()
      child.once('exit', () => clearTimeout(killTimer))
      if (error) reject(error)
      else resolve(usage!)
    }
    const timer = setTimeout(() => finish(new Error("Codex didn't report its usage in time.")), 15_000)
    const send = (message: object): void => { child.stdin.write(`${JSON.stringify(message)}\n`) }
    child.on('error', () => finish(new Error('Could not start Codex to read plan usage.')))
    child.stdin.on('error', () => finish(new Error('Codex disconnected while reading plan usage.')))
    child.on('exit', () => finish(new Error('Codex exited before reporting plan usage.')))
    lines.on('line', (line) => {
      if (settled) return
      try {
        const message = JSON.parse(line)
        if (message.id !== 1 && message.id !== 2 && message.id !== 3) return
        if (message.error) {
          finish(new Error('Codex could not read plan usage. Check that Codex is signed in and try again.'))
        } else if (message.id === 1) {
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'account/read', params: { refreshToken: false } })
        } else if (message.id === 2) {
          const account = message.result?.account
          if (!account) finish(new Error('Sign in to Codex to see plan usage.'))
          else if (account.type === 'apiKey') {
            finish(null, { plan: null, available: false, limits: [], extraUsage: null })
          } else send({ id: 3, method: 'account/rateLimits/read' })
        } else {
          finish(null, codexPlanUsage(message.result))
        }
      } catch {
        finish(new Error('Codex returned an invalid plan usage response.'))
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'gloss', title: 'Gloss', version: '0.1.0' } } })
  })
}
