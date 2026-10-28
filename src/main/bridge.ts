import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http'
import type { SecureContextOptions } from 'node:tls'
import { extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { GlossEvent } from '../shared/ipc'
import type { Device } from '../shared/types'
import type { Store } from './db'
import type { PhoneApi } from './phoneApi'

// The bridge (SPEC → Remote and mobile): the phone client's files, pairing, and one WebSocket per
// phone carrying the same calls and events a window's IPC does. It listens only where it's told
// (the Tailscale address), and every call but the client's files and pairing needs a device token.

export const COOKIE = 'gloss_device'
const PAIR_TTL = 5 * 60_000
const MAX_PAIR_FAILURES = 5
const TOUCH_EVERY = 60_000
/** Images up to 10 MB each, base64, a few to a message. */
const MAX_MESSAGE = 48 * 1024 * 1024

/** Events only a desktop window acts on, or that carry what a phone mustn't see (settings hold MCP secrets). */
const DESKTOP_ONLY = new Set<GlossEvent['type']>([
  'settings', 'phone', 'fullScreen', 'confirmClose', 'captureShortcut', 'annotateMaximized', 'windows', 'popIn', 'mainAction', 'reveal'
])

export type Pairing = { url: string; expiresAt: number }

/** Calls the bridge answers itself rather than through the shared handlers. */
export type BridgeCalls = {
  /** What the phone needs from settings, without the settings themselves. */
  info(): unknown
  /** Which sessions run or wait on the user now, for a phone that connects mid-turn. */
  activity(): unknown
  pushKey(): string | null
}

export type BridgeOptions = {
  store: Store
  phoneApi: PhoneApi
  /** The renderer build (`out/renderer`), whose `mobile.html` and assets the phone loads. */
  staticDir: string
  calls: BridgeCalls
  /** Devices, connections or pairing changed: Settings → Phone shows them. */
  onChange(): void
  now?: () => number
}

export type ListenOptions = {
  /** The address to listen on: the Tailscale IPv4 address. */
  ip: string
  port: number
  /** The page's origin, e.g. `https://my-pc.tail1234.ts.net:8443`; requests from elsewhere are refused. */
  origin: string
  /** `https.createServer` with the certificate (tests pass plain `http`). */
  createServer(handler: RequestListener): Server
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
}

export class Bridge {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private origin = ''
  private pairing: { code: string; expiresAt: number; failures: number; timer: NodeJS.Timeout } | null = null
  /** Open sockets by device id. */
  private readonly sockets = new Map<string, Set<WebSocket>>()
  private readonly touched = new Map<string, number>()
  /** The session each connection shows while the page is in front (null: none), so pushes skip it. */
  private readonly viewing = new Map<WebSocket, { deviceId: string; sessionId: string | null }>()
  private readonly now: () => number

  constructor(private readonly opts: BridgeOptions) {
    this.now = opts.now ?? Date.now
  }

  get listening(): boolean {
    return this.server?.listening === true
  }

  async start(listen: ListenOptions): Promise<void> {
    await this.stop()
    this.origin = listen.origin
    const server = listen.createServer((req, res) => void this.request(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
    }))
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE })
    server.on('upgrade', (req, socket, head) => {
      const device = new URL(req.url ?? '/', 'http://x').pathname === '/api' && this.sameOrigin(req) ? this.device(req) : undefined
      if (!device) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws, device))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(listen.port, listen.ip, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.wss = wss
    this.opts.onChange()
  }

  async stop(): Promise<void> {
    this.cancelPairing()
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, 'Gloss stopped phone access')
    this.sockets.clear()
    this.wss?.close()
    this.wss = null
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      this.opts.onChange()
    }
  }

  /** Switches the running server to a renewed certificate. New connections get it; open ones keep going. */
  setCertificate(cert: Buffer, key: Buffer): void {
    const server = this.server as (Server & { setSecureContext?(options: SecureContextOptions): void }) | null
    server?.setSecureContext?.({ cert, key })
  }

  /** The address the server listens on (its port, for tests that pass 0). */
  address(): { port: number } | null {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { port: a.port } : null
  }

  // Pairing

  /** A one-time code for a QR code; replaces any earlier one. */
  startPairing(): Pairing {
    if (!this.listening) throw new Error('Turn on phone access first.')
    this.cancelPairing()
    const code = randomBytes(16).toString('base64url')
    const expiresAt = this.now() + PAIR_TTL
    const timer = setTimeout(() => this.cancelPairing(), PAIR_TTL)
    timer.unref?.()
    this.pairing = { code, expiresAt, failures: 0, timer }
    this.opts.onChange()
    return { url: `${this.origin}/pair#${code}`, expiresAt }
  }

  cancelPairing(): void {
    if (!this.pairing) return
    clearTimeout(this.pairing.timer)
    this.pairing = null
    this.opts.onChange()
  }

  get pairingOpen(): boolean {
    return this.pairing !== null && this.pairing.expiresAt > this.now()
  }

  // Devices

  devices(): (Device & { connected: boolean })[] {
    return this.opts.store.listDevices().map((d) => ({ ...d, connected: (this.sockets.get(d.id)?.size ?? 0) > 0 }))
  }

  /** Revokes a phone: its connections close at once and its token stops working. */
  removeDevice(id: string): void {
    this.opts.store.deleteDevice(id)
    for (const ws of this.sockets.get(id) ?? []) ws.close(4001, 'This phone was removed')
    this.sockets.delete(id)
    this.opts.onChange()
  }

  /** Sends an event to every connected phone, unless only windows act on it. */
  broadcast(event: GlossEvent): void {
    if (DESKTOP_ONLY.has(event.type)) return
    const data = JSON.stringify({ event })
    for (const set of this.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data)
  }

  // HTTP

  private sameOrigin(req: IncomingMessage): boolean {
    return req.headers.origin === this.origin
  }

  private device(req: IncomingMessage): Device | undefined {
    const cookie = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
    if (!cookie || cookie.length > 100) return undefined
    return this.opts.store.deviceByTokenHash(hash(cookie))
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (req.method === 'POST' && path === '/pair') return this.pair(req, res)
    if (req.method === 'GET' && path === '/me') {
      const device = this.device(req)
      if (!device) return void res.writeHead(401, { 'Cache-Control': 'no-store' }).end()
      return json(res, 200, { id: device.id, name: device.name })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end()
    // The client's own files only: its page (for every app route), assets and install files.
    const file = path === '/' || path === '/pair' || path === '/mobile.html' ? 'mobile.html'
      : path.startsWith('/assets/') || ['/sw.js', '/mobile.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'].includes(path) ? path.slice(1)
      : null
    if (!file) return void res.writeHead(404).end()
    const full = normalize(join(this.opts.staticDir, file))
    if (!full.startsWith(normalize(this.opts.staticDir) + sep)) return void res.writeHead(404).end()
    let body: Buffer
    try {
      body = await readFile(full)
    } catch {
      return void res.writeHead(404).end()
    }
    const headers: Record<string, string> = { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream' }
    if (file === 'mobile.html' || file === 'sw.js') {
      headers['Cache-Control'] = 'no-store'
      headers['Content-Security-Policy'] = csp(this.origin)
    } else if (file.startsWith('assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    // Icons and the manifest keep their names across builds, so the phone checks for new ones.
    else headers['Cache-Control'] = 'no-cache'
    if (file === 'sw.js') headers['Service-Worker-Allowed'] = '/'
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body)
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.sameOrigin(req)) return json(res, 403, { error: 'Pair from the page Gloss showed.' })
    let body: { code?: unknown; name?: unknown }
    try {
      body = JSON.parse(await readBody(req, 4096)) as typeof body
    } catch {
      return json(res, 400, { error: 'Bad request.' })
    }
    const pairing = this.pairing
    if (!pairing || pairing.expiresAt <= this.now()) return json(res, 410, { error: 'This pairing code expired. Show a new one in Gloss\'s Settings → Phone.' })
    const code = typeof body.code === 'string' ? Buffer.from(body.code) : Buffer.alloc(0)
    const expected = Buffer.from(pairing.code)
    if (code.length !== expected.length || !timingSafeEqual(code, expected)) {
      pairing.failures++
      if (pairing.failures >= MAX_PAIR_FAILURES) this.cancelPairing()
      return json(res, 403, { error: 'That pairing code isn\'t right. Scan the code Gloss shows again.' })
    }
    this.cancelPairing()
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Phone'
    const token = randomBytes(32).toString('base64url')
    const device = { id: randomUUID(), name, tokenHash: hash(token), createdAt: this.now() }
    this.opts.store.insertDevice(device)
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`)
    json(res, 200, { id: device.id, name })
    this.opts.onChange()
  }

  // WebSocket

  private connected(ws: WebSocket, device: Device): void {
    let set = this.sockets.get(device.id)
    if (!set) this.sockets.set(device.id, (set = new Set()))
    set.add(ws)
    this.touch(device.id, true)
    this.opts.onChange()
    ws.on('message', (data) => void this.message(ws, device.id, String(data)))
    ws.on('close', () => {
      this.viewing.delete(ws)
      set.delete(ws)
      if (set.size === 0 && this.sockets.get(device.id) === set) this.sockets.delete(device.id)
      this.opts.onChange()
    })
  }

  private touch(id: string, force = false): void {
    const at = this.now()
    if (!force && at - (this.touched.get(id) ?? 0) < TOUCH_EVERY) return
    this.touched.set(id, at)
    this.opts.store.touchDevice(id, at)
  }

  private async message(ws: WebSocket, deviceId: string, data: string): Promise<void> {
    let msg: { id?: unknown; channel?: unknown; args?: unknown }
    try {
      msg = JSON.parse(data) as typeof msg
    } catch {
      return
    }
    const id = msg.id
    if (typeof id !== 'number' || typeof msg.channel !== 'string') return
    // A removed phone's socket is closed, but a message may already be in flight.
    if (!this.sockets.get(deviceId)?.has(ws)) return void ws.close(4001, 'This phone was removed')
    this.touch(deviceId)
    const args = Array.isArray(msg.args) ? msg.args : []
    try {
      const result = await this.call(ws, deviceId, msg.channel, args)
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id, result: result ?? null }))
    } catch (err) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id, error: err instanceof Error ? err.message : String(err) }))
    }
  }

  /** Phones showing this session now: a push about it would interrupt what they already see. */
  viewers(sessionId: string): Set<string> {
    return new Set([...this.viewing.values()].filter((v) => v.sessionId === sessionId).map((v) => v.deviceId))
  }

  private async call(ws: WebSocket, deviceId: string, channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case 'bridge:info': return this.opts.calls.info()
      case 'bridge:viewing':
        this.viewing.set(ws, { deviceId, sessionId: typeof args[0] === 'string' ? args[0] : null })
        return null
      case 'bridge:pushKey': return this.opts.calls.pushKey()
      case 'bridge:activity': return this.opts.calls.activity()
      case 'bridge:subscribe': {
        const sub = args[0] as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
          throw new Error('Invalid push subscription')
        }
        this.opts.store.setDevicePush(deviceId, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }))
        this.opts.onChange()
        return null
      }
      case 'bridge:unsubscribe':
        this.opts.store.setDevicePush(deviceId, null)
        this.opts.onChange()
        return null
      default:
        return this.opts.phoneApi.call(channel, args)
    }
  }
}

/** The phone page's policy: its own scripts, styles and socket; images from itself or data URLs. */
export function csp(origin: string): string {
  const ws = origin.replace(/^http/, 'ws')
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${ws}; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
