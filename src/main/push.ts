import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush, { type PushSubscription, type RequestOptions } from 'web-push'
import type { Store } from './db'

// Web push to paired phones (SPEC → Remote and mobile → Notifications).

export type PushPayload = { title: string; body: string; sessionId: string; threadId: string | null }
export type SendPush = (sub: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>

export class PushSender {
  private keys: { publicKey: string; privateKey: string } | null = null

  constructor(
    private readonly dir: string,
    private readonly store: Store,
    private readonly sendPush: SendPush = (sub, payload, options) => webpush.sendNotification(sub, payload, options)
  ) {}

  /** The VAPID public key phones subscribe with; made once and kept in the data folder. */
  publicKey(): string {
    return this.vapid().publicKey
  }

  /**
   * Sends to every phone with notifications on. `subject` is the bridge's `https://` origin:
   * Apple refuses a `mailto:` at a reserved domain (BadJwtToken).
   */
  async send(payload: PushPayload, subject: string, skip: ReadonlySet<string> = new Set()): Promise<void> {
    const { publicKey, privateKey } = this.vapid()
    const data = JSON.stringify(payload)
    await Promise.all(this.store.devicePushSubscriptions().filter(({ id }) => !skip.has(id)).map(async ({ id, subscription }) => {
      try {
        await this.sendPush(JSON.parse(subscription) as PushSubscription, data, { vapidDetails: { subject, publicKey, privateKey }, TTL: 3600 })
      } catch (err) {
        // The phone unsubscribed, or the browser dropped it.
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) this.store.setDevicePush(id, null)
      }
    }))
  }

  private vapid(): { publicKey: string; privateKey: string } {
    if (this.keys) return this.keys
    const file = join(this.dir, 'bridge-vapid.json')
    if (existsSync(file)) this.keys = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string }
    else {
      this.keys = webpush.generateVAPIDKeys()
      writeFileSync(file, JSON.stringify(this.keys), { mode: 0o600 })
    }
    return this.keys
  }
}
