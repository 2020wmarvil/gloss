import { createServer } from 'node:https'
import QRCode from 'qrcode'
import type { GlossEvent, PhoneStatus } from '../shared/ipc'
import { Bridge, type BridgeCalls } from './bridge'
import type { Store } from './db'
import type { PhoneApi } from './phoneApi'
import { PushSender, type PushPayload } from './push'
import { tailscaleCert, tailscaleStatus } from './tailscale'

// Settings → Phone (SPEC → Remote and mobile): turns the bridge on and off with the setting,
// gets Tailscale's certificate, shows pairing and devices, and pushes to phones.

export type PhoneOptions = {
  dataDir: string
  staticDir: string
  store: Store
  phoneApi: PhoneApi
  calls: Omit<BridgeCalls, 'pushKey'>
  /** Settings → Phone changed. */
  onStatus(status: PhoneStatus): void
}

const OFF = { state: 'off', error: null, origin: null, machine: null, ip: null, certExpiresAt: null, certWarning: null } as const satisfies Partial<PhoneStatus>
/** How often the certificate is checked while the bridge is on. */
const RENEW_EVERY = 24 * 60 * 60_000
/**
 * How often a bridge that should be on but isn't listening is started again: it listens on the Tailscale
 * address, which is gone for a while after the computer wakes or before Tailscale connects at login.
 */
const HEAL_EVERY = 30_000
/** How long after a wake to restart the bridge, giving Tailscale a moment to reconnect. */
const WAKE_DELAY = 5_000

export class PhoneService {
  private readonly bridge: Bridge
  private readonly push: PushSender
  private state: Pick<PhoneStatus, 'state' | 'error' | 'origin' | 'machine' | 'ip' | 'certExpiresAt' | 'certWarning'> = OFF
  private pairing: PhoneStatus['pairing'] = null
  private wanted: { on: boolean; port: number } = { on: false, port: 8443 }
  /** Start, stop and renewal run one at a time, in order. */
  private queue: Promise<void> = Promise.resolve()
  /** The tailnet name the certificate is for, while the bridge is on. */
  private host: string | null = null
  private renewTimer: ReturnType<typeof setInterval> | undefined
  private readonly healTimer: ReturnType<typeof setInterval>
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  /** Starts and stops queued or running. */
  private pending = 0

  constructor(private readonly opts: PhoneOptions) {
    this.push = new PushSender(opts.dataDir, opts.store)
    this.bridge = new Bridge({
      store: opts.store,
      phoneApi: opts.phoneApi,
      staticDir: opts.staticDir,
      calls: { ...opts.calls, pushKey: () => this.push.publicKey() },
      onChange: () => {
        if (this.pairing && !this.bridge.pairingOpen) this.pairing = null
        this.changed()
      }
    })
    this.healTimer = setInterval(() => this.heal(), HEAL_EVERY)
    this.healTimer.unref?.()
  }

  status(): PhoneStatus {
    return { ...this.state, pairing: this.pairing, devices: this.bridge.devices() }
  }

  /** Follows the settings: starts, restarts on a new port, or stops the bridge. */
  apply(on: boolean, port: number): Promise<void> {
    const changed = on !== this.wanted.on || port !== this.wanted.port
    this.wanted = { on, port }
    if (!changed) return this.queue
    return this.run()
  }

  /** Tries again after an error. */
  retry(): Promise<void> {
    return this.run()
  }

  /** The computer woke: its Tailscale address went away while asleep, so the server starts over once it's back. */
  woke(): void {
    clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      if (this.wanted.on) void this.run()
    }, WAKE_DELAY)
    this.wakeTimer.unref?.()
  }

  /** Starts the bridge again if it should be on but isn't listening, unless a start is already under way. */
  private heal(): void {
    if (this.wanted.on && this.pending === 0 && !this.bridge.listening) void this.run()
  }

  async pair(): Promise<PhoneStatus> {
    const { url, expiresAt } = this.bridge.startPairing()
    const qr = `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })).toString('base64')}`
    this.pairing = { url, qr, expiresAt }
    this.changed()
    return this.status()
  }

  cancelPairing(): void {
    this.pairing = null
    this.bridge.cancelPairing()
  }

  removeDevice(id: string): void {
    this.bridge.removeDevice(id)
  }

  broadcast(event: GlossEvent): void {
    this.bridge.broadcast(event)
  }

  /** A turn ended or the agent waits on the user, and no Gloss window is focused. Phones showing the session are skipped. */
  notify(payload: PushPayload): void {
    if (this.state.state !== 'on' || !this.state.origin) return
    void this.push.send(payload, this.state.origin, this.bridge.viewers(payload.sessionId)).catch(() => {})
  }

  dispose(): Promise<void> {
    clearInterval(this.healTimer)
    clearTimeout(this.wakeTimer)
    this.wanted = { ...this.wanted, on: false }
    return this.run()
  }

  /**
   * Asks Tailscale for the certificate again, daily: it reissues one once under 30 days are left, and
   * the server switches to it without dropping phones (SPEC → Remote and mobile).
   */
  private renew(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const host = this.host
      if (!host || this.state.state !== 'on') return
      try {
        const cert = await tailscaleCert(host, this.opts.dataDir)
        if (this.host !== host) return
        if (cert.expiresAt !== this.state.certExpiresAt) this.bridge.setCertificate(cert.cert, cert.key)
        this.state = { ...this.state, certExpiresAt: cert.expiresAt, certWarning: null }
      } catch (err) {
        const until = this.state.certExpiresAt ? new Date(this.state.certExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
        this.state = { ...this.state, certWarning: `${err instanceof Error ? err.message : String(err)} The current one works${until ? ` until ${until}` : ''}; Gloss tries again tomorrow.` }
      }
      this.changed()
    }).catch(() => {})
    return this.queue
  }

  private run(): Promise<void> {
    this.pending++
    this.queue = this.queue.then(() => this.sync()).catch(() => {}).finally(() => { this.pending-- })
    return this.queue
  }

  private async sync(): Promise<void> {
    const { on, port } = this.wanted
    this.pairing = null
    clearInterval(this.renewTimer)
    this.host = null
    await this.bridge.stop()
    if (!on) {
      this.state = OFF
      return this.changed()
    }
    this.state = { ...this.state, state: 'starting', error: null }
    this.changed()
    try {
      const ts = await tailscaleStatus()
      const cert = await tailscaleCert(ts.host, this.opts.dataDir)
      const origin = `https://${ts.host}:${port}`
      await this.bridge.start({ ip: ts.ip, port, origin, createServer: (handler) => createServer({ cert: cert.cert, key: cert.key }, handler) })
      this.state = { state: 'on', error: null, origin, machine: ts.machine, ip: ts.ip, certExpiresAt: cert.expiresAt, certWarning: null }
      this.host = ts.host
      this.renewTimer = setInterval(() => void this.renew(), RENEW_EVERY)
      this.renewTimer.unref?.()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const error = code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Choose another port.`
        : err instanceof Error ? err.message : String(err)
      this.state = { ...OFF, state: 'error', error }
    }
    this.changed()
  }

  private changed(): void {
    this.opts.onStatus(this.status())
  }
}
