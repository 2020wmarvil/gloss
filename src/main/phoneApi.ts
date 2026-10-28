import { IPC } from '../shared/ipc'

/**
 * The calls a paired phone may make, by IPC channel (SPEC → Remote and mobile). Not settings, reviews,
 * capture, sign-in, MCP import, anything that opens a file, folder or editor on the desktop, disk exports,
 * windows or the badge: a phone runs the same handlers a window does, but only these.
 */
export const PHONE_CHANNELS: ReadonlySet<string> = new Set([
  IPC.agentsList,
  IPC.agentsRateLimits,
  IPC.projectsList,
  IPC.sessionsList,
  IPC.sessionsCreate,
  IPC.sessionsOpen,
  IPC.sessionsRefresh,
  IPC.sessionsRewindPoints,
  IPC.sessionsRewind,
  IPC.sessionsSetChoice,
  IPC.sessionsSetMode,
  IPC.sessionsSetAutoApprove,
  IPC.sessionsPlanUsage,
  IPC.requestsAnswer,
  IPC.threadsCreate,
  IPC.threadsResolve,
  IPC.history,
  IPC.send,
  IPC.steer,
  IPC.retry,
  IPC.cancel,
  IPC.queueEdit,
  IPC.queueRemove,
  IPC.queueResume,
  IPC.readMarkdownImage
])

export type PhoneHandler = (...args: unknown[]) => unknown

/** The handlers shared by windows and phones, filled as the main process registers them. */
export class PhoneApi {
  private readonly handlers = new Map<string, PhoneHandler>()

  add(channel: string, handler: PhoneHandler): void {
    if (!PHONE_CHANNELS.has(channel)) throw new Error(`${channel} isn't open to phones`)
    this.handlers.set(channel, handler)
  }

  /** Runs a phone's call. Rejects channels outside the allowlist, whatever was registered. */
  async call(channel: string, args: unknown[]): Promise<unknown> {
    const handler = PHONE_CHANNELS.has(channel) ? this.handlers.get(channel) : undefined
    if (!handler) throw new Error('This isn\'t available from a phone.')
    return handler(...args)
  }
}
