import { describe, expect, it, vi } from 'vitest'
import { isUsageLimitFailure, parseResetTime, resolveUsageLimitFailure } from './usageLimit'

describe('usageLimit', () => {
  const now = Date.parse('2026-11-19T03:00:00Z') // 10:00 PM EST on Nov 18

  describe('isUsageLimitFailure', () => {
    it('detects Claude synthetic usage limit errors', () => {
      expect(isUsageLimitFailure('claude', "You've hit your limit · resets 3:10am (America/New_York)", null, [], now)).toBe(true)
      expect(isUsageLimitFailure('claude', "You've reached your weekly usage limit", null, [], now)).toBe(true)
    })

    it('detects Codex structured usageLimitExceeded and rateLimitExceeded', () => {
      const usageCause = { data: { codexErrorInfo: 'usageLimitExceeded' } }
      const rateCause = { data: { codexErrorInfo: 'rateLimitExceeded' } }
      const http429Cause = { data: { codexErrorInfo: { responseError: { httpStatusCode: 429 } } } }
      expect(isUsageLimitFailure('codex', 'Request failed', usageCause, [], now)).toBe(true)
      expect(isUsageLimitFailure('codex', 'Request failed', rateCause, [], now)).toBe(true)
      expect(isUsageLimitFailure('codex', 'Request failed', http429Cause, [], now)).toBe(true)
    })

    it('detects Antigravity quota reached and RESOURCE_EXHAUSTED errors', () => {
      expect(
        isUsageLimitFailure(
          'antigravity',
          'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h12m30s',
          null,
          [],
          now
        )
      ).toBe(true)
      expect(isUsageLimitFailure('antigravity', 'RESOURCE_EXHAUSTED: model quota exceeded', null, [], now)).toBe(true)
    })

    it('ignores unsupported agents and unrelated failures', () => {
      expect(isUsageLimitFailure('opencode', 'Rate limit exceeded', null, [], now)).toBe(false)
      expect(isUsageLimitFailure('custom:foo', 'Rate limit exceeded', null, [], now)).toBe(false)
      expect(isUsageLimitFailure('claude', 'Network connection closed', null, [], now)).toBe(false)
      expect(isUsageLimitFailure('codex', 'Process exited with code 1', null, [], now)).toBe(false)
      expect(isUsageLimitFailure('antigravity', 'Invalid tool arguments', null, [], now)).toBe(false)
    })
  })

  describe('parseResetTime', () => {
    it('parses Antigravity compact and multi-day relative durations', () => {
      expect(parseResetTime('Individual quota reached. Resets in 4h12m30s', now)).toBe(
        now + (4 * 3600 + 12 * 60 + 30) * 1000
      )
      expect(parseResetTime('Individual quota reached. Resets in 144h12m', now)).toBe(
        now + (144 * 3600 + 12 * 60) * 1000
      )
      expect(parseResetTime('Quota exceeded. Try again in 5d 2h 10m.', now)).toBe(
        now + (5 * 86400 + 2 * 3600 + 10 * 60) * 1000
      )
      expect(parseResetTime('Rate limit hit, retry in 45 minutes', now)).toBe(now + 45 * 60_000)
    })

    it('parses ISO 8601 timestamps', () => {
      const target = '2026-11-19T08:10:00Z'
      expect(parseResetTime(`Usage limit reached. Resets at ${target}`, now)).toBe(Date.parse(target))
      // Past ISO timestamps are ignored.
      expect(parseResetTime('Resets at 2026-11-18T00:00:00Z', now)).toBeNull()
    })

    it('parses Claude wall-clock times with explicit IANA timezone and rolls to next day', () => {
      // now is 2026-11-18 22:00 America/New_York (EST, UTC-5) -> 3:10am is 2026-11-19 03:10 EST = 08:10Z
      expect(parseResetTime("You've hit your limit · resets 3:10am (America/New_York)", now)).toBe(
        Date.parse('2026-11-19T08:10:00Z')
      )
      // 11pm is still today (2026-11-18 23:00 EST = 2026-11-19 04:00Z)
      expect(parseResetTime("You've hit your limit · resets 11pm (America/New_York)", now)).toBe(
        Date.parse('2026-11-19T04:00:00Z')
      )
    })

    it('parses explicit month/day + time with timezone (weekly limits)', () => {
      expect(parseResetTime("You've reached your weekly limit · resets Nov 25, 3:10pm (America/New_York)", now)).toBe(
        Date.parse('2026-11-25T20:10:00Z')
      )
      expect(parseResetTime('Usage limit exceeded. Try again at Nov 20th, 2026 9:00 AM UTC.', now)).toBe(
        Date.parse('2026-11-20T09:00:00Z')
      )
    })

    it('parses tomorrow and weekday reset phrases', () => {
      // 2026-11-19 03:00Z is Thursday in UTC; Friday 04:00Z is 2026-11-20T04:00:00Z
      expect(parseResetTime('Resets tomorrow at 4:00 AM UTC', now)).toBe(Date.parse('2026-11-20T04:00:00Z'))
      expect(parseResetTime('Resets Mon 9:30 AM UTC', now)).toBe(Date.parse('2026-11-23T09:30:00Z'))
    })

    it('returns null when no reset time is present', () => {
      expect(parseResetTime('Quota exceeded. Upgrade your plan.', now)).toBeNull()
    })
  })

  describe('resolveUsageLimitFailure', () => {
    it('prefers live rejected rateLimits and picks the latest blocking reset', async () => {
      const fiveHour = now + 3600_000
      const weekly = now + 4 * 86_400_000
      const fetchPlanUsage = vi.fn()
      const res = await resolveUsageLimitFailure({
        agentId: 'claude',
        cwd: '/repo',
        errorText: "You've hit your limit",
        cause: null,
        rateLimits: [
          { window: 'five_hour', status: 'rejected', resetsAt: fiveHour },
          { window: 'seven_day', status: 'rejected', resetsAt: weekly }
        ],
        now,
        fetchPlanUsage
      })
      expect(res).toEqual({ isLimit: true, resetsAt: weekly })
      expect(fetchPlanUsage).not.toHaveBeenCalled()
    })

    it('falls back to promptless plan usage for Codex when error text has no timestamp', async () => {
      const resetsAt = now + 2 * 3600_000
      const fetchPlanUsage = vi.fn().mockResolvedValue({
        plan: 'Plus',
        available: true,
        limits: [
          { label: '5-hour limit', percent: 100, resetsAt },
          { label: 'Weekly limit', percent: 40, resetsAt: now + 5 * 86_400_000 }
        ],
        extraUsage: null
      })
      const res = await resolveUsageLimitFailure({
        agentId: 'codex',
        cwd: '/repo',
        errorText: 'Usage limit exceeded',
        cause: { data: { codexErrorInfo: 'usageLimitExceeded' } },
        rateLimits: [],
        now,
        fetchPlanUsage
      })
      expect(res).toEqual({ isLimit: true, resetsAt })
      expect(fetchPlanUsage).toHaveBeenCalledWith('codex', '/repo')
    })

    it('returns isLimit without resetsAt when Antigravity gives no time', async () => {
      const fetchPlanUsage = vi.fn()
      const res = await resolveUsageLimitFailure({
        agentId: 'antigravity',
        cwd: '/repo',
        errorText: 'RESOURCE_EXHAUSTED: individual quota reached',
        cause: null,
        rateLimits: [],
        now,
        fetchPlanUsage
      })
      expect(res).toEqual({ isLimit: true })
      expect(fetchPlanUsage).not.toHaveBeenCalled()
    })
  })
})
