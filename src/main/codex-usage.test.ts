import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexPlanUsage, fetchCodexUsage, type CodexUsageResponse } from './codex-usage'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const response: CodexUsageResponse = {
  rateLimits: { planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792000000 },
    secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: null } }
}

function server(): {
  child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
  sent: () => { id?: number; method: string; params?: unknown }[]
  reply: (id: number, result: unknown) => void
} {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  })
  let input = ''
  child.stdin.on('data', (chunk) => { input += chunk.toString() })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return { child, sent: () => input.trim().split('\n').map((line) => JSON.parse(line)),
    reply: (id, result) => { child.stdout.write(JSON.stringify({ id, result }) + '\n') } }
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('Codex plan usage', () => {
  it('preserves used percentages, converts reset seconds, and labels by window duration', () => {
    expect(codexPlanUsage(response)).toEqual({ plan: 'Pro', available: true, extraUsage: null, limits: [
      { label: '5-hour limit', percent: 25, resetsAt: 1792000000000 },
      { label: 'Weekly limit', percent: 38, resetsAt: null }
    ] })
    expect(codexPlanUsage({ rateLimits: { primary: response.rateLimits.secondary } }).limits[0].label).toBe('Weekly limit')
  })

  it('prefers named multi-bucket limits over the legacy duplicate', () => {
    const result = codexPlanUsage({ ...response, rateLimitsByLimitId: {
      codex: response.rateLimits,
      other: { limitName: 'Other model', primary: { usedPercent: 100, windowDurationMins: 15, resetsAt: null } }
    } })
    expect(result.limits.map((limit) => limit.label)).toEqual([
      'codex · 5-hour limit', 'codex · Weekly limit', 'Other model · 15-minute limit'
    ])
    expect(result.limits[2].percent).toBe(100)
    expect(codexPlanUsage({ rateLimits: {} }).limits).toEqual([])
  })

  it('initializes, reads account limits without a thread or prompt, and closes stdin', async () => {
    const s = server()
    const pending = fetchCodexUsage('/project')
    expect(s.sent().map((m) => m.method)).toEqual(['initialize'])
    s.reply(1, {})
    expect(s.sent().map((m) => m.method)).toEqual(['initialize', 'initialized', 'account/read'])
    s.reply(2, { account: { type: 'chatgpt' } })
    s.child.stdout.write('{"method":"account/updated","params":{}}\n')
    expect(s.sent().at(-1)?.method).toBe('account/rateLimits/read')
    // Split transport chunks are reassembled by readline.
    const line = JSON.stringify({ id: 3, result: response }) + '\n'
    s.child.stdout.write(line.slice(0, 15))
    s.child.stdout.write(line.slice(15))
    expect(await pending).toEqual(codexPlanUsage(response))
    expect(s.child.stdin.writableEnded).toBe(true)
    s.child.emit('exit', 0)
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ windowsHide: true, cwd: '/project' })
  })

  it('does not request subscription limits for API key accounts', async () => {
    const s = server()
    const pending = fetchCodexUsage('/project')
    s.reply(1, {})
    s.reply(2, { account: { type: 'apiKey' } })
    expect((await pending).available).toBe(false)
    expect(s.sent().map((m) => m.method)).not.toContain('account/rateLimits/read')
    s.child.emit('exit', 0)
  })

  it.each(['timeout', 'exit', 'error', 'rpc', 'invalid'])('rejects and cleans up after %s', async (failure) => {
    vi.useFakeTimers()
    const s = server()
    const pending = fetchCodexUsage('/project')
    const rejected = expect(pending).rejects.toThrow(/Codex/)
    if (failure === 'timeout') vi.advanceTimersByTime(15000)
    if (failure === 'exit') s.child.emit('exit', 1)
    if (failure === 'error') s.child.emit('error', new Error('failed'))
    if (failure === 'rpc') s.child.stdout.write('{"id":1,"error":{"message":"sensitive"}}\n')
    if (failure === 'invalid') s.child.stdout.write('invalid\n')
    await rejected
    expect(s.child.stdin.writableEnded).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(s.child.kill).toHaveBeenCalledOnce()
    s.child.emit('exit', 0)
  })
})
