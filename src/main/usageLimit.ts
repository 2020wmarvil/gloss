// Usage-limit detection and reset-time resolution for Claude Code, Codex and Antigravity.
import type { PlanUsage, RateLimit } from '../shared/types'

/** Built-in agents that support wait-and-continue on usage limits. */
export const AUTO_CONTINUE_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'antigravity'])

/** The follow-up sent in the same thread once the usage limit resets. */
export const CONTINUE_AT_USAGE_LIMIT_PROMPT = 'Continue where you left off.'

/** Small buffer past a reported reset timestamp so the server window has flipped before we continue. */
export const DEFAULT_RESUME_BUFFER_MS = 15_000

const CLAUDE_LIMIT_PREFIXES = [
  "You've hit your",
  "You've reached your"
]

const TEXT_LIMIT_PATTERNS = [
  /\byou'?ve\s+(?:hit|reached)\s+your\b/i,
  /\b(?:usage|rate|session|weekly|five[- ]?hour|5[- ]?hour|token|message|plan|account)\s+limit(?:\s+(?:reached|exceeded|hit))?\b/i,
  /\b(?:individual\s+)?quota\s+(?:reached|exceeded|exhausted|limit)\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\btoo\s+many\s+requests\b/i,
  /\b(?:http|status(?:\s+code)?|error)\s*:?\s*429\b/i,
  /\b429\b.*\b(?:limit|quota|too\s+many)\b/i
]

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
}

/** Pulls structured ACP error data (`RequestError.data`) if present. */
function errorData(cause: unknown): Record<string, unknown> | null {
  if (!cause || typeof cause !== 'object') return null
  const data = (cause as { data?: unknown }).data
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
}

/** Extracts additional text hints from structured ACP error payloads. */
function causeTexts(cause: unknown): string[] {
  const data = errorData(cause)
  if (!data) return []
  const out: string[] = []
  for (const key of ['message', 'additionalDetails', 'detail', 'details']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) out.push(value)
  }
  return out
}

function hasStructuredLimitError(cause: unknown): boolean {
  const data = errorData(cause)
  if (!data) return false
  const codex = data.codexErrorInfo
  if (codex === 'usageLimitExceeded' || codex === 'rateLimitExceeded') return true
  if (codex && typeof codex === 'object') {
    for (const v of Object.values(codex)) {
      if (v && typeof v === 'object' && (v as { httpStatusCode?: unknown }).httpStatusCode === 429) return true
    }
  }
  if (data.errorKind === 'rate_limit' || data.kind === 'rate_limited' || data.kind === 'quota_exhausted') return true
  if (data.status === 429 || data.httpStatusCode === 429) return true
  return false
}

/** Whether a turn failure for `agentId` was caused by a usage or rate limit. */
export function isUsageLimitFailure(
  agentId: string,
  errorText: string,
  cause: unknown,
  rateLimits: readonly RateLimit[],
  now: number
): boolean {
  if (!AUTO_CONTINUE_AGENTS.has(agentId)) return false
  if (hasStructuredLimitError(cause)) return true
  const texts = [errorText, ...causeTexts(cause)].filter(Boolean)
  for (const text of texts) {
    const trimmed = text.trim()
    if (agentId === 'claude' && CLAUDE_LIMIT_PREFIXES.some((p) => trimmed.startsWith(p))) return true
    if (TEXT_LIMIT_PATTERNS.some((re) => re.test(trimmed))) return true
  }
  // If Claude already flagged a rejected rate-limit window on this account, treat a limit-flavored failure as one.
  const hasRejected = rateLimits.some((l) => l.status === 'rejected' && (l.resetsAt === undefined || l.resetsAt > now))
  if (hasRejected && texts.some((t) => /\b(?:limit|quota|reset|try again|rate)\b/i.test(t))) return true
  return false
}

/** Converts a wall-clock date/time in an optional IANA timezone to epoch ms. */
function wallClockToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone?: string
): number | null {
  if (!timeZone) {
    const ms = new Date(year, month, day, hour, minute, 0, 0).getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (/^(?:UTC|GMT|Z)$/i.test(timeZone)) {
    return Date.UTC(year, month, day, hour, minute, 0, 0)
  }
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
  } catch {
    return null
  }
  const targetUtc = Date.UTC(year, month, day, hour, minute, 0, 0)
  let guess = targetUtc
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]))
    const shownUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    )
    const diff = targetUtc - shownUtc
    if (diff === 0) break
    guess += diff
  }
  return Number.isFinite(guess) ? guess : null
}

/** Local (or timezone-adjusted) calendar date parts for `now`. */
function datePartsInZone(now: number, timeZone?: string): { year: number; month: number; day: number; weekday: number } {
  if (!timeZone) {
    const d = new Date(now)
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay() }
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: /^(?:UTC|GMT|Z)$/i.test(timeZone) ? 'UTC' : timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short'
    })
    const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]))
    const wd = WEEKDAYS[parts.weekday.toLowerCase()] ?? new Date(now).getDay()
    return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day), weekday: wd }
  } catch {
    const d = new Date(now)
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay() }
  }
}

function to24Hour(hour: number, meridiem?: string): number | null {
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    const lower = meridiem.toLowerCase()
    if (lower === 'am') return hour === 12 ? 0 : hour
    if (lower === 'pm') return hour === 12 ? 12 : hour + 12
    return null
  }
  return hour >= 0 && hour <= 23 ? hour : null
}

/**
 * Parses a usage-limit reset timestamp from an error message across Claude, Codex and Antigravity.
 * Handles relative durations ("Resets in 4h12m30s", "try again in 45 minutes"), ISO timestamps,
 * and wall-clock times with optional dates and timezones ("resets 3:10am (America/New_York)",
 * "resets Nov 20, 3:10pm", "try again at 15:30").
 */
export function parseResetTime(text: string, now: number): number | null {
  if (!text) return null

  // 1. Relative durations: "Resets in 4h12m30s", "Resets in 5d 2h", "try again in 45 minutes"
  const rel = text.match(
    /(?:resets?|try\s+again|retry|available|wait)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\s*,?\s*(?:and\s+)?)?)+)/i
  )
  if (rel) {
    let totalMs = 0
    for (const part of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)) {
      const n = Number(part[1])
      const unit = part[2].toLowerCase()
      if (unit.startsWith('d')) totalMs += n * 86_400_000
      else if (unit.startsWith('h')) totalMs += n * 3_600_000
      else if (unit.startsWith('m')) totalMs += n * 60_000
      else if (unit.startsWith('s')) totalMs += n * 1_000
    }
    if (totalMs > 0) return now + totalMs
  }

  // 2. ISO 8601 timestamp: "2026-11-19T08:10:00Z" or with explicit offset
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/)
  if (iso) {
    const ms = Date.parse(iso[0])
    if (Number.isFinite(ms) && ms > now) return ms
  }

  // 3. Date and/or clock time after a reset/retry cue:
  //    "resets 3:10am (America/New_York)", "resets Nov 20, 3:10pm", "try again at 3:10 PM"
  const cue = text.match(
    /(?:resets?|try\s+again|retry|available|until|after)(?:\s+(?:at|on))?\s+([^\n.;!?()]+?)(?:\s*\(([A-Za-z0-9_/+.-]+)\))?(?:[\n.;!?]|$)/i
  )
  if (cue) {
    const phrase = cue[1].trim()
    let tz = cue[2]?.trim()
    const tzSuffix = !tz ? phrase.match(/\b(UTC|GMT)\b$/i) : null
    if (tzSuffix) tz = tzSuffix[1].toUpperCase()

    const timeMatch = phrase.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i)
    if (timeMatch) {
      const hourRaw = Number(timeMatch[1] ?? timeMatch[4])
      const minute = Number(timeMatch[2] ?? timeMatch[5] ?? '0')
      const meridiem = timeMatch[3]
      const hour = to24Hour(hourRaw, meridiem)
      if (hour !== null && minute >= 0 && minute <= 59) {
        const base = datePartsInZone(now, tz)

        // Explicit month + day (+ optional year): "Nov 20", "Nov 20th, 2026", "20 Nov"
        const md = phrase.match(
          /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i
        )
        if (md) {
          const month = MONTHS[md[1].toLowerCase()]
          const day = Number(md[2])
          const year = md[3] ? Number(md[3]) : base.year
          let ms = wallClockToEpoch(year, month, day, hour, minute, tz)
          if (ms !== null && !md[3] && ms <= now - 86_400_000) {
            ms = wallClockToEpoch(year + 1, month, day, hour, minute, tz)
          }
          if (ms !== null && ms > now) return ms
        }

        // "tomorrow"
        if (/\btomorrow\b/i.test(phrase)) {
          const ms = wallClockToEpoch(base.year, base.month, base.day + 1, hour, minute, tz)
          if (ms !== null && ms > now) return ms
        }

        // Weekday: "Thu 3:10 PM", "Monday at 9am"
        const wd = phrase.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i)
        if (wd) {
          const targetDay = WEEKDAYS[wd[1].toLowerCase()]
          let delta = (targetDay - base.weekday + 7) % 7
          let ms = wallClockToEpoch(base.year, base.month, base.day + delta, hour, minute, tz)
          if (ms !== null && ms <= now) {
            delta += 7
            ms = wallClockToEpoch(base.year, base.month, base.day + delta, hour, minute, tz)
          }
          if (ms !== null && ms > now) return ms
        }

        // Time-only: today if still ahead, else tomorrow.
        let ms = wallClockToEpoch(base.year, base.month, base.day, hour, minute, tz)
        if (ms !== null && ms <= now) {
          ms = wallClockToEpoch(base.year, base.month, base.day + 1, hour, minute, tz)
        }
        if (ms !== null && ms > now) return ms
      }
    }
  }

  return null
}

/**
 * Classifies a failed turn and resolves its usage-limit reset timestamp (ms since epoch) if available.
 * Never sends a model turn: uses live rate-limit state, error text parsing, and (for Claude/Codex)
 * Gloss's existing promptless plan-usage lookup.
 */
export async function resolveUsageLimitFailure(options: {
  agentId: string
  cwd: string
  errorText: string
  cause: unknown
  rateLimits: readonly RateLimit[]
  now: number
  fetchPlanUsage?: (agentId: string, cwd: string) => Promise<PlanUsage | null>
}): Promise<{ isLimit: boolean; resetsAt?: number }> {
  const { agentId, cwd, errorText, cause, rateLimits, now, fetchPlanUsage } = options
  if (!isUsageLimitFailure(agentId, errorText, cause, rateLimits, now)) {
    return { isLimit: false }
  }

  // 1. Live rejected rate-limit windows reported over ACP (Claude Code).
  const rejectedResets = rateLimits
    .filter((l) => l.status === 'rejected' && l.resetsAt !== undefined && l.resetsAt > now)
    .map((l) => l.resetsAt!)
  if (rejectedResets.length > 0) {
    return { isLimit: true, resetsAt: Math.max(...rejectedResets) }
  }

  // 2. Parse reset timestamp/duration directly from the error text or structured payload.
  for (const text of [errorText, ...causeTexts(cause)]) {
    const parsed = parseResetTime(text, now)
    if (parsed !== null && parsed > now) {
      return { isLimit: true, resetsAt: parsed }
    }
  }

  // 3. Promptless plan usage lookup (Claude /usage SDK query or Codex app-server rateLimits/read).
  if (fetchPlanUsage && (agentId === 'claude' || agentId === 'codex')) {
    try {
      const usage = await fetchPlanUsage(agentId, cwd)
      if (usage?.available && usage.limits.length > 0) {
        const exhausted = usage.limits
          .filter((l) => l.percent >= 99 && l.resetsAt !== null && l.resetsAt > now)
          .map((l) => l.resetsAt!)
        if (exhausted.length > 0) {
          return { isLimit: true, resetsAt: Math.max(...exhausted) }
        }
        // Fallback: highest-utilization window >= 95% with a future reset.
        const nearFull = usage.limits
          .filter((l) => l.percent >= 95 && l.resetsAt !== null && l.resetsAt > now)
          .sort((a, b) => b.percent - a.percent)
        if (nearFull.length > 0 && nearFull[0].resetsAt !== null) {
          return { isLimit: true, resetsAt: nearFull[0].resetsAt }
        }
      }
    } catch {
      // Usage lookup is best-effort; still report it as a usage limit so the manual picker works.
    }
  }

  return { isLimit: true }
}
