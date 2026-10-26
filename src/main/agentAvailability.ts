import { setImmediate } from 'node:timers'
import type { OpenCodeStatus } from '../shared/ipc'

/** Optional agent probing must not hold up the list of known agents. */
export class AgentAvailability {
  private current?: { key: string; at: number; status?: OpenCodeStatus }

  constructor(
    private readonly probe: (key: string) => Promise<OpenCodeStatus>,
    private readonly changed: (key: string, status: OpenCodeStatus) => void,
    private readonly now = Date.now
  ) {}

  get(key: string): OpenCodeStatus | undefined {
    const previous = this.current
    if (previous?.key === key && (previous.status === undefined || this.now() - previous.at < 30_000)) return previous.status
    const entry = { key, at: this.now(), status: previous?.key === key ? previous.status : undefined }
    this.current = entry
    setImmediate(() => {
      if (this.current !== entry) return
      void this.probe(key).catch((): OpenCodeStatus => ({
        available: false, executable: null, version: null, error: 'Could not check OpenCode availability. Test its connection in Settings.'
      })).then((status) => {
        if (this.current !== entry) return
        this.set(key, status)
      })
    })
    return entry.status
  }

  /** A manual connection test supersedes an older background check. */
  set(key: string, status: OpenCodeStatus): void {
    this.current = { key, at: this.now(), status }
    this.changed(key, status)
  }
}
