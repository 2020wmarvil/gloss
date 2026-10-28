import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Store } from './db'
import { PushSender } from './push'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-push-'))
  const store = new Store(':memory:')
  for (const id of ['a', 'b', 'c']) store.insertDevice({ id, name: id, tokenHash: `h${id}`, createdAt: 1 })
  const sub = (n: string) => JSON.stringify({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'x' } })
  store.setDevicePush('a', sub('a'))
  store.setDevicePush('b', sub('b'))
  return { dir, store }
}

describe('PushSender', () => {
  it('sends to subscribed phones with an https subject, and drops gone subscriptions', async () => {
    const { dir, store } = setup()
    const sendPush = vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/b')) throw Object.assign(new Error('gone'), { statusCode: 410 })
    })
    const push = new PushSender(dir, store, sendPush)
    await push.send({ title: 'T', body: 'The agent finished.', sessionId: 's', threadId: null }, 'https://my-pc.tail1234.ts.net:8443')
    expect(sendPush).toHaveBeenCalledTimes(2)
    const [, payload, options] = sendPush.mock.calls[0] as unknown as [unknown, string, { vapidDetails: { subject: string; publicKey: string } }]
    expect(JSON.parse(payload)).toEqual({ title: 'T', body: 'The agent finished.', sessionId: 's', threadId: null })
    expect(options.vapidDetails.subject).toBe('https://my-pc.tail1234.ts.net:8443')
    expect(options.vapidDetails.publicKey).toBe(push.publicKey())
    expect(store.listDevices().map((d) => d.notifications)).toEqual([true, false, false])
  })

  it('skips phones showing the session', async () => {
    const { dir, store } = setup()
    const sendPush = vi.fn(async () => {})
    await new PushSender(dir, store, sendPush).send({ title: 'T', body: 'B', sessionId: 's', threadId: null }, 'https://x', new Set(['a']))
    expect(sendPush.mock.calls.map((c) => (c as unknown as [{ endpoint: string }])[0].endpoint)).toEqual(['https://push.example/b'])
  })

  it('keeps its keys across restarts', () => {
    const { dir, store } = setup()
    expect(new PushSender(dir, store).publicKey()).toBe(new PushSender(dir, store).publicKey())
  })
})
