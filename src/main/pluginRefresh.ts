type Deps = {
  /** Restarts the agent's connection if none of its turns is running; false when it's busy. */
  restartIdleAgent(agentId: string): Promise<boolean>
  /** Deploys what the library says, now that the agent is idle. */
  reconcile(): void
  markPending(agentIds: string[]): void
  refreshed(agentId: string): void
  /** The Plugins screen has something new to show. */
  changed(): void
}

/**
 * Applies plugin changes to agents (SPEC → Plugins): each changed agent restarts once it's
 * idle, so its next session/new or session/load picks up the plugins. A busy agent waits for
 * its turn to end (`retry`). A change made while an agent restarts restarts it again.
 */
export class PluginRefresh {
  /** A revision per agent, bumped by each change, so one made during a restart isn't lost. */
  private readonly pending = new Map<string, number>()
  private applying = false
  /** A request came while applying: go round again for it. */
  private requested = false

  constructor(private readonly deps: Deps) {}

  request(agentIds: string[]): void {
    for (const id of agentIds) this.pending.set(id, (this.pending.get(id) ?? 0) + 1)
    this.deps.markPending(agentIds)
    this.deps.changed()
    void this.apply()
  }

  /** After a turn ends: applies what waited for it. */
  retry(): void {
    if (this.pending.size) void this.apply()
  }

  async apply(): Promise<void> {
    if (this.applying) {
      this.requested = true
      return
    }
    this.applying = true
    this.requested = false
    try {
      for (const [id, revision] of [...this.pending]) {
        if (!(await this.deps.restartIdleAgent(id))) continue
        this.deps.reconcile()
        // Changed during the restart: the next round restarts it again.
        if (this.pending.get(id) !== revision) continue
        this.pending.delete(id)
        this.deps.refreshed(id)
      }
      this.deps.changed()
    } catch (error) {
      console.error('[plugins] Could not refresh agent connections:', error)
    } finally {
      this.applying = false
      if (this.requested) void this.apply()
    }
  }
}
