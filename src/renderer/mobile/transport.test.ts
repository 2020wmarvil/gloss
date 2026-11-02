// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PING_TIMEOUT, PhoneLink, type Link } from './transport'

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeSocket[] = []
  readyState = FakeSocket.CONNECTING
  sent: { id: number; channel: string }[] = []
  /** Answers pings by itself: an earlier test's link, which still hears visibilitychange. */
  live = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  constructor() {
    FakeSocket.all.push(this)
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { id: number; channel: string }
    this.sent.push(msg)
    if (this.live && msg.channel === 'bridge:ping') queueMicrotask(() => this.answer(msg.id))
  }
  close(): void {
    this.readyState = FakeSocket.CLOSING
  }
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  answer(id: number): void {
    this.onmessage?.({ data: JSON.stringify({ id, result: null }) })
  }
}

function setVisible(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

let links: Link[]
let link: PhoneLink

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
  link = new PhoneLink()
  links = []
  link.onLink((l) => links.push(l))
  link.connect()
  FakeSocket.all[0].open()
})

afterEach(() => {
  for (const ws of FakeSocket.all) ws.live = true
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('pings an open socket when the page comes back to the front, and keeps it when answered', async () => {
  setVisible('hidden')
  setVisible('visible')
  const ws = FakeSocket.all[0]
  const ping = ws.sent.find((m) => m.channel === 'bridge:ping')
  expect(ping).toBeDefined()
  ws.answer(ping!.id)
  await vi.advanceTimersByTimeAsync(PING_TIMEOUT * 2)
  expect(FakeSocket.all).toHaveLength(1)
  expect(link.link).toBe('online')
})

it('drops a socket that doesn\'t answer the ping and reconnects at once, without asking whether the phone was removed', async () => {
  const pending = link.invoke('sessions:list').catch((e: Error) => e.message)
  setVisible('visible')
  await vi.advanceTimersByTimeAsync(PING_TIMEOUT)
  expect(FakeSocket.all[0].readyState).toBe(FakeSocket.CLOSING)
  expect(await pending).toBe('Gloss is offline.')
  expect(links).toEqual(['online', 'offline'])
  expect(fetch).not.toHaveBeenCalled()
  // The retry has no delay after a link that was up (fake timers run it after 1 ms).
  await vi.advanceTimersByTimeAsync(1)
  expect(FakeSocket.all).toHaveLength(2)
  FakeSocket.all[1].open()
  expect(link.link).toBe('online')
})
