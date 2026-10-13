import { useEffect, useState } from 'react'
import type { PlanUsage, SessionLive } from '@shared/types'
import { errorText } from './errors'

export function resetIn(ms: number, now = Date.now()): string {
  const minutes = Math.ceil((ms - now) / 60_000)
  if (minutes <= 0) return 'Resets soon'
  if (minutes < 60) return `Resets in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Resets in ${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `Resets in ${Math.floor(hours / 24)} days ${hours % 24} hr`
}

function UsageMeter({ label, percent, detail }: { label: string; percent: number; detail?: string }): React.JSX.Element {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div className={`usage-window${percent >= 100 ? ' exhausted' : percent >= 80 ? ' high' : ''}`}>
      <div className="usage-heading"><span>{label}</span><span>{Math.round(percent)}%</span></div>
      <div className="usage-meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <span style={{ width: `${value}%` }} />
      </div>
      {detail && <div className="muted">{detail}</div>}
    </div>
  )
}

/** Mounted only while the popup is open. Late responses are ignored after closing. */
export function UsagePanel({ sessionId, context }: { sessionId: string; context: SessionLive['usage'] }): React.JSX.Element {
  const [usage, setUsage] = useState<PlanUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setUsage(null)
    setError(null)
    window.gloss.sessions.planUsage(sessionId).then(
      (value) => { if (active) { setUsage(value); setLoading(false) } },
      (err: unknown) => { if (active) { setError(errorText(err)); setLoading(false) } }
    )
    return () => { active = false }
  }, [sessionId, attempt])

  return (
    <section className="usage-panel" aria-label="Usage details">
      <div className="usage-heading"><strong>Usage</strong>{usage?.plan && <span className="muted">{usage.plan}</span>}</div>
      {context && context.size > 0 && (
        <UsageMeter label="Context window" percent={context.used / context.size * 100}
          detail={`${context.used.toLocaleString()} of ${context.size.toLocaleString()} tokens`} />
      )}
      {loading && <p className="muted" role="status">Loading plan usage…</p>}
      {error && <div role="alert"><p>Couldn&apos;t load plan usage: {error}</p><button onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>}
      {!loading && !error && (!usage || !usage.available) && <p className="muted">Plan limits are unavailable for this account.</p>}
      {usage?.available && <>
        {usage.limits.map((limit) => <UsageMeter key={limit.label} label={limit.label} percent={limit.percent}
          detail={limit.resetsAt === null ? undefined : resetIn(limit.resetsAt)} />)}
        {usage.limits.length === 0 && <p className="muted">No plan limits reported.</p>}
        {usage.extraUsage && (usage.extraUsage.percent === null
          ? <p className="muted">Extra usage enabled</p>
          : <UsageMeter label="Extra usage" percent={usage.extraUsage.percent} />)}
      </>}
    </section>
  )
}
