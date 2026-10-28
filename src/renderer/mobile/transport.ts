// The phone's link to the desktop (SPEC → Remote and mobile): one WebSocket carrying the same
// calls a window's preload makes, and its events. Offline, nothing is sent or queued; it
// reconnects with backoff and right away when the page comes back to the front.
import type { GlossEvent } from '@shared/ipc'
import type { ApiTransport } from '@shared/api'

/** `removed`: the desktop refused this phone's token (revoked, or never paired). */
export type Link = 'connecting' | 'online' | 'offline' | 'removed'

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

export class PhoneLink implements ApiTransport {
  private ws: WebSocket | null = null
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: GlossEvent) => void>()
  private readonly linkListeners = new Set<(link: Link) => void>()
  private delay = 1000
  private timer: ReturnType<typeof setTimeout> | undefined
  link: Link = 'connecting'

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.link === 'offline') this.connect()
    })
  }

  connect(): void {
    clearTimeout(this.timer)
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api`)
    this.ws = ws
    ws.onopen = () => {
      this.delay = 1000
      this.setLink('online')
    }
    ws.onmessage = (e) => this.message(String(e.data))
    ws.onclose = (e) => void this.closed(e.code)
  }

  onLink(listener: (link: Link) => void): () => void {
    this.linkListeners.add(listener)
    return () => this.linkListeners.delete(listener)
  }

  invoke(channel: string, ...args: unknown[]): Promise<never> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Gloss is offline.'))
    const id = this.next++
    return new Promise<never>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ id, channel, args }))
    })
  }

  send(channel: string, ...args: unknown[]): void {
    void this.invoke(channel, ...args).catch(() => {})
  }

  onEvent(listener: (event: GlossEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pathFor(): string {
    return ''
  }

  private message(data: string): void {
    const msg = JSON.parse(data) as { id?: number; result?: unknown; error?: string; event?: GlossEvent }
    if (msg.event) {
      for (const l of this.listeners) l(msg.event)
      return
    }
    const p = msg.id === undefined ? undefined : this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id!)
    if (msg.error !== undefined) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }

  private async closed(code: number): Promise<void> {
    this.ws = null
    for (const p of this.pending.values()) p.reject(new Error('Gloss is offline.'))
    this.pending.clear()
    // 4001: removed while connected. A refused upgrade gives 1006 like a lost network, so ask.
    if (code === 4001 || (await removed())) return this.setLink('removed')
    this.setLink('offline')
    this.timer = setTimeout(() => this.connect(), this.delay)
    this.delay = Math.min(this.delay * 2, 10_000)
  }

  private setLink(link: Link): void {
    this.link = link
    for (const l of this.linkListeners) l(link)
  }
}

/** The desktop answered and doesn't know this phone (as opposed to not answering). */
async function removed(): Promise<boolean> {
  try {
    return (await fetch('/me', { cache: 'no-store' })).status === 401
  } catch {
    return false
  }
}
