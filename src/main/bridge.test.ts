import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { IPC } from '../shared/ipc'
import { Bridge, COOKIE } from './bridge'
import { Store } from './db'
import { PhoneApi } from './phoneApi'

// The bridge over plain HTTP on loopback; in the app it's HTTPS on the Tailscale address.
let store: Store
let api: PhoneApi
let bridge: Bridge
let origin: string
let changes: number

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-bridge-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'mobile.html'), '<!doctype html><title>phone</title>')
  writeFileSync(join(dir, 'index.html'), 'desktop page')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  store = new Store(':memory:')
  api = new PhoneApi()
  api.add(IPC.sessionsList, () => [{ id: 's1' }])
  changes = 0
  bridge = new Bridge({ store, phoneApi: api, staticDir: dir, calls: { info: () => ({ host: 'test' }), activity: () => ({}), pushKey: () => 'key' }, onChange: () => changes++ })
  // The origin needs the port, which listen picks; start once to learn it, then with the real origin.
  await bridge.start({ ip: '127.0.0.1', port: 0, origin: 'http://placeholder', createServer: (h) => createServer(h) })
  const port = bridge.address()!.port
  origin = `http://127.0.0.1:${port}`
  await bridge.start({ ip: '127.0.0.1', port, origin, createServer: (h) => createServer(h) })
})

afterEach(async () => {
  await bridge.stop()
  store.close()
})

async function pair(name = 'Test phone'): Promise<string> {
  const { url } = bridge.startPairing()
  const code = url.split('#')[1]
  const res = await fetch(`${origin}/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')!
  expect(cookie).toMatch(/HttpOnly/)
  expect(cookie).toMatch(/Secure/)
  expect(cookie).toMatch(/SameSite=Strict/)
  return cookie.split(';')[0]
}

function connect(cookie: string | null, from = origin): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api`, { headers: { origin: from, ...(cookie ? { cookie } : {}) } })
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.once('error', reject)
  })
}

function call(ws: WebSocket, id: number, channel: string, args: unknown[] = []): Promise<{ id: number; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer): void => {
      const msg = JSON.parse(String(data)) as { id?: number }
      if (msg.id !== id) return
      ws.off('message', onMessage)
      resolve(msg as { id: number; result?: unknown; error?: string })
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, channel, args }))
  })
}

describe('Bridge', () => {
  it('serves the phone page with a strict policy, and nothing outside the client', async () => {
    const page = await fetch(`${origin}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('phone')
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect((await fetch(`${origin}/pair`)).status).toBe(200)
    const asset = await fetch(`${origin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${origin}/index.html`)).status).toBe(404)
    expect((await fetch(`${origin}/assets/../index.html`)).status).toBe(404)
    expect((await fetch(`${origin}/assets/%2e%2e/index.html`)).status).toBe(404)
  })

  it('pairs a phone with a one-time code and lists it', async () => {
    expect((await fetch(`${origin}/me`)).status).toBe(401)
    const cookie = await pair()
    const me = await fetch(`${origin}/me`, { headers: { cookie } })
    expect(await me.json()).toMatchObject({ name: 'Test phone' })
    expect(bridge.devices()).toMatchObject([{ name: 'Test phone', connected: false, notifications: false }])
    // The code is gone once used.
    expect(bridge.pairingOpen).toBe(false)
    expect(store.listDevices()[0]).not.toHaveProperty('tokenHash')
    expect(JSON.stringify(store.listDevices())).not.toContain(cookie.split('=')[1])
  })

  it('refuses wrong codes, cross-site pairing, and stops after five wrong codes', async () => {
    const { url } = bridge.startPairing()
    const code = url.split('#')[1]
    const post = (body: unknown, from = origin) => fetch(`${origin}/pair`, { method: 'POST', headers: { origin: from }, body: JSON.stringify(body) })
    expect((await post({ code }, 'https://evil.example')).status).toBe(403)
    for (let i = 0; i < 5; i++) expect((await post({ code: 'x'.repeat(code.length) })).status).toBe(403)
    expect(bridge.pairingOpen).toBe(false)
    expect((await post({ code })).status).toBe(410)
    expect(store.listDevices()).toEqual([])
  })

  it('expires a pairing code after five minutes', async () => {
    vi.useFakeTimers()
    try {
      bridge.startPairing()
      vi.advanceTimersByTime(5 * 60_000 + 1)
      expect(bridge.pairingOpen).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('needs a device token and the bridge\'s own origin to connect', async () => {
    await expect(connect(null)).rejects.toThrow('HTTP 401')
    await expect(connect(`${COOKIE}=forged`)).rejects.toThrow('HTTP 401')
    const cookie = await pair()
    await expect(connect(cookie, 'https://evil.example')).rejects.toThrow('HTTP 401')
    const ws = await connect(cookie)
    expect(bridge.devices()[0].connected).toBe(true)
    ws.close()
  })

  it('runs allowlisted calls through the shared handlers and refuses the rest', async () => {
    const ws = await connect(await pair())
    expect(await call(ws, 1, IPC.sessionsList)).toEqual({ id: 1, result: [{ id: 's1' }] })
    expect(await call(ws, 2, IPC.settingsGet)).toMatchObject({ id: 2, error: expect.stringContaining('isn\'t available from a phone') })
    expect(await call(ws, 3, 'bridge:info')).toEqual({ id: 3, result: { host: 'test' } })
    ws.close()
  })

  it('stores a push subscription for the device', async () => {
    const ws = await connect(await pair())
    const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } }
    expect(await call(ws, 1, 'bridge:subscribe', [sub])).toEqual({ id: 1, result: null })
    expect(store.listDevices()[0].notifications).toBe(true)
    expect(await call(ws, 2, 'bridge:subscribe', [{ endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } }])).toMatchObject({ error: 'Invalid push subscription' })
    expect(await call(ws, 3, 'bridge:unsubscribe')).toEqual({ id: 3, result: null })
    expect(store.listDevices()[0].notifications).toBe(false)
    ws.close()
  })

  it('knows which phones show a session, until they look away or disconnect', async () => {
    const ws = await connect(await pair())
    const id = bridge.devices()[0].id
    await call(ws, 1, 'bridge:viewing', ['s1'])
    expect([...bridge.viewers('s1')]).toEqual([id])
    expect(bridge.viewers('s2').size).toBe(0)
    await call(ws, 2, 'bridge:viewing', [null])
    expect(bridge.viewers('s1').size).toBe(0)
    await call(ws, 3, 'bridge:viewing', ['s1'])
    const closed = new Promise((r) => ws.once('close', r))
    ws.close()
    await closed
    await new Promise((r) => setTimeout(r, 20))
    expect(bridge.viewers('s1').size).toBe(0)
  })

  it('sends events to phones, except desktop-only ones', async () => {
    const ws = await connect(await pair())
    const got: unknown[] = []
    ws.on('message', (d) => got.push(JSON.parse(String(d))))
    bridge.broadcast({ type: 'fullScreen' })
    bridge.broadcast({ type: 'settings', state: {} as never })
    bridge.broadcast({ type: 'cancel' as never } as never)
    bridge.broadcast({ type: 'turnStart', sessionId: 's1', threadId: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(got).toEqual([{ event: { type: 'cancel' } }, { event: { type: 'turnStart', sessionId: 's1', threadId: null } }])
    ws.close()
  })

  it('closes a removed phone\'s connections and refuses its token', async () => {
    const cookie = await pair()
    const ws = await connect(cookie)
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    const before = changes
    bridge.removeDevice(bridge.devices()[0].id)
    expect(await closed).toBe(4001)
    expect(changes).toBeGreaterThan(before)
    expect((await fetch(`${origin}/me`, { headers: { cookie } })).status).toBe(401)
    await expect(connect(cookie)).rejects.toThrow('HTTP 401')
  })

  it('closes every connection when phone access is turned off', async () => {
    const ws = await connect(await pair())
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    await bridge.stop()
    expect(await closed).toBe(1001)
    expect(bridge.listening).toBe(false)
  })
})
