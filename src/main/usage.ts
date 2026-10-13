// Plan usage for the usage popup (SPEC → Status line), from Claude Code itself.
// The ACP adapter only runs Claude Code's usage request inside a `/usage` turn, so
// Gloss asks a short-lived Claude Code process of its own: no prompt, nothing saved.
import type { PlanUsage } from '../shared/types'

/** A result this recent is answered again instead of asking Claude Code. */
const FRESH_MS = 30_000
const TIMEOUT_MS = 15_000

type Window = { utilization: number | null; resets_at: string | null } | null | undefined

/** The fields Gloss reads from the Agent SDK's SDKControlGetUsageResponse (an experimental API). */
export type UsageResponse = {
  subscription_type: string | null
  rate_limits_available: boolean
  rate_limits: {
    five_hour?: Window
    seven_day?: Window
    seven_day_opus?: Window
    seven_day_sonnet?: Window
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[]
    extra_usage?: { is_enabled: boolean; utilization: number | null } | null
  } | null
}

function resetsAt(iso: string | null): number | null {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? null : ms
}

/** The popup's view of Claude Code's usage response, with its windows in the order and words `/usage` uses. */
export function planUsage(response: UsageResponse): PlanUsage {
  const plan = response.subscription_type
  const limits: PlanUsage['limits'] = []
  const add = (label: string, window: Window): void => {
    if (window && typeof window.utilization === 'number') {
      limits.push({ label, percent: window.utilization, resetsAt: resetsAt(window.resets_at) })
    }
  }
  const rl = response.rate_limits_available ? response.rate_limits : null
  if (rl) {
    add('Session limit', rl.five_hour)
    add('Weekly · all models', rl.seven_day)
    const models = rl.model_scoped ?? []
    for (const m of models) add(`Weekly · ${m.display_name}`, m)
    if (models.length === 0) {
      add('Weekly · Opus', rl.seven_day_opus)
      add('Weekly · Sonnet', rl.seven_day_sonnet)
    }
  }
  const extra = rl?.extra_usage
  return {
    plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null,
    available: rl !== null,
    limits,
    extraUsage: extra?.is_enabled ? { percent: extra.utilization } : null
  }
}

/** Asks Claude Code for the usage behind `/usage`, through the Agent SDK. */
async function fetchClaudeUsage(cwd: string): Promise<PlanUsage> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abort = new AbortController()
  // The request needs a running query; an input that never yields keeps it promptless.
  // eslint-disable-next-line require-yield -- Sending even one prompt would create an unwanted turn.
  async function* noPrompt(): AsyncGenerator<never> {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve))
  }
  const q = query({ prompt: noPrompt(), options: { cwd, persistSession: false, abortController: abort } })
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const response = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) =>
        abort.signal.addEventListener('abort', () => reject(new Error("Claude Code didn't report its usage in time.")))
      )
    ])
    return planUsage(response)
  } finally {
    clearTimeout(timer)
    abort.abort()
    q.close()
  }
}

/** Plan usage per agent, answered from the last result while it is fresh. */
export class UsageSource {
  private last: { at: number; usage: PlanUsage } | null = null
  private pending: Promise<PlanUsage> | null = null

  constructor(private readonly fetch: (cwd: string) => Promise<PlanUsage> = fetchClaudeUsage) {}

  /** Null for agents Gloss can't ask. */
  async get(agentId: string, cwd: string): Promise<PlanUsage | null> {
    if (agentId !== 'claude') return null
    if (this.last && Date.now() - this.last.at < FRESH_MS) return this.last.usage
    this.pending ??= this.fetch(cwd)
      .then((usage) => {
        this.last = { at: Date.now(), usage }
        return usage
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }
}
