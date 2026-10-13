import { afterEach, describe, expect, it, vi } from 'vitest'
import { planUsage, UsageSource, type UsageResponse } from './usage'

const response: UsageResponse = {
  subscription_type: 'pro', rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 100, resets_at: '2026-10-13T22:00:00Z' },
    seven_day: { utilization: 38, resets_at: null },
    seven_day_opus: { utilization: 7, resets_at: null },
    model_scoped: [{ display_name: 'Sonnet', utilization: 12, resets_at: 'invalid' }],
    extra_usage: { is_enabled: true, utilization: null }
  }
}

afterEach(() => vi.useRealTimers())

describe('plan usage', () => {
  it('preserves percentage units, prefers model windows, and tolerates missing reset times', () => {
    expect(planUsage(response)).toEqual({
      plan: 'Pro', available: true,
      limits: [
        { label: 'Session limit', percent: 100, resetsAt: Date.parse('2026-10-13T22:00:00Z') },
        { label: 'Weekly · all models', percent: 38, resetsAt: null },
        { label: 'Weekly · Sonnet', percent: 12, resetsAt: null }
      ], extraUsage: { percent: null }
    })
    expect(planUsage({ ...response, rate_limits: { ...response.rate_limits, model_scoped: [] } }).limits.at(-1)?.label).toBe('Weekly · Opus')
  })

  it('does not invent plan limits for API accounts', () => {
    expect(planUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toEqual({
      plan: null, available: false, limits: [], extraUsage: null
    })
  })

  it('shares concurrent requests, caches successful results, and refreshes after 30 seconds', async () => {
    vi.useFakeTimers()
    const usage = planUsage(response)
    const fetch = vi.fn(async () => usage)
    const source = new UsageSource(fetch)
    await Promise.all([source.get('claude', '/project'), source.get('claude', '/project')])
    await source.get('claude', '/project')
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_001)
    expect(await source.get('claude', '/project')).toEqual(usage)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('allows retry after failure and skips unsupported agents', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(planUsage(response))
    const source = new UsageSource(fetch)
    expect(await source.get('other', '/project')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    await expect(source.get('claude', '/project')).rejects.toThrow('offline')
    expect(await source.get('claude', '/project')).toEqual(planUsage(response))
  })
})
