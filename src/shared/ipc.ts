// Types shared by the main process, the preload bridge and the renderer.
// Type-only: nothing here may pull runtime code into the sandboxed preload.
import type {
  AgentCapabilities,
  Implementation,
  SessionUpdate,
  StopReason
} from '@agentclientprotocol/sdk'

export type Settings = {
  /** Spawn agents with ANTHROPIC_MODEL=haiku so development prompts are cheap. */
  devModel: boolean
}

export type GlossEvent =
  | { type: 'log'; level: 'info' | 'error'; text: string }
  | {
      type: 'capabilities'
      protocolVersion: number
      agentInfo: Implementation | null
      agentCapabilities: AgentCapabilities | null
    }
  | { type: 'update'; update: SessionUpdate }
  | { type: 'turn-end'; stopReason: StopReason }

export type GlossApi = {
  settings: {
    get(): Promise<Settings>
    setDevModel(on: boolean): Promise<Settings>
  }
  /** M1 spike: spawn the agent, open a session and send one hard-coded prompt. */
  spike: {
    run(): Promise<void>
  }
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  onEvent(listener: (event: GlossEvent) => void): () => void
}

export const IPC = {
  settingsGet: 'gloss:settings:get',
  settingsSetDevModel: 'gloss:settings:setDevModel',
  spikeRun: 'gloss:spike:run',
  event: 'gloss:event'
} as const
