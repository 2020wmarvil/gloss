// M1 spike: spawn the agent, initialize, open a session, send one hard-coded
// prompt, and report every session/update plus the final stopReason.
import type { GlossEvent } from '../shared/ipc'
import { AgentConnection } from './acp'
import { agentEnv, getAgentConfig } from './agents'
import { getSettings } from './settings'

const SPIKE_PROMPT =
  'Without using any tools, give me a short numbered list of three tips for writing readable TypeScript.'

let running = false
let active: AgentConnection | undefined

export async function runSpike(cwd: string, emit: (event: GlossEvent) => void): Promise<void> {
  if (running) throw new Error('The spike is already running.')
  running = true
  const log = (text: string, level: 'info' | 'error' = 'info'): void => {
    ;(level === 'error' ? console.error : console.log)(`[gloss] ${text}`)
    emit({ type: 'log', level, text })
  }

  try {
    const config = getAgentConfig('claude')
    const { devModel } = getSettings()
    log(`Spawning ${config.name}${devModel ? ' (dev model: haiku)' : ''}`)

    const agent = await AgentConnection.start(config, agentEnv(config, { devModel }), {
      onUpdate(notification) {
        console.log('[acp] session/update', JSON.stringify(notification.update))
        emit({ type: 'update', update: notification.update })
      },
      async onPermission(request) {
        // Permissions arrive in M5. For now decline, preferring a reject option.
        const reject = request.options.find((o) => o.kind === 'reject_once')
        log(`Permission requested for "${request.toolCall.title ?? 'tool call'}"; declining (M5).`)
        return reject
          ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      },
      onStderr(line) {
        console.error('[agent stderr]', line)
      },
      onExit(code, signal) {
        log(`Agent process exited (code ${code}, signal ${signal})`)
      }
    })
    active = agent

    const { protocolVersion, agentInfo, agentCapabilities } = agent.init
    console.log('[acp] initialize', JSON.stringify(agent.init, null, 2))
    log(`Connected: ${agentInfo?.title ?? agentInfo?.name ?? 'agent'} ${agentInfo?.version ?? ''}`)
    log(`loadSession: ${agentCapabilities?.loadSession === true}`)
    emit({
      type: 'capabilities',
      protocolVersion,
      agentInfo: agentInfo ?? null,
      agentCapabilities: agentCapabilities ?? null
    })

    const session = await agent.newSession(cwd)
    log(`Session ${session.sessionId} in ${cwd}`)
    log(`Prompt: ${SPIKE_PROMPT}`)

    const { stopReason } = await agent.prompt(session.sessionId, SPIKE_PROMPT)
    log(`Turn ended: stopReason=${stopReason}`)
    emit({ type: 'turn-end', stopReason })
  } catch (err) {
    log(err instanceof Error ? (err.stack ?? err.message) : String(err), 'error')
    throw err
  } finally {
    active?.dispose()
    active = undefined
    running = false
  }
}

export function disposeSpike(): void {
  active?.dispose()
  active = undefined
}
