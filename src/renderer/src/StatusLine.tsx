// The status line at the bottom of the conversation (SPEC → Status line). Everything
// but the git branch comes from what the agent reports over ACP.
import { useState } from 'react'
import type { GitStatus } from '@shared/ipc'
import { folderName } from '@shared/paths'
import type { Session, SessionLive, SlashCommand } from '@shared/types'
import { Popover } from './Popover'

type Props = {
  session: Session
  live: SessionLive
  git: GitStatus | null
  devModel: boolean
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  runningLabel: string | null
  onOpenThread(threadId: string): void
  onSetModel(value: string): Promise<void>
  /** Sends a slash command as a message in the main thread. */
  onCommand(text: string): void
}

function formatCost(cost: { amount: number; currency: string }): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cost.currency, maximumFractionDigits: 2 }).format(cost.amount)
  } catch {
    return `${cost.amount.toFixed(2)} ${cost.currency}`
  }
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Commands grouped for the extensions panel: MCP prompts are named "mcp:<server>:<prompt>". */
function groupCommands(commands: SlashCommand[]): { title: string; commands: SlashCommand[] }[] {
  const mcp = commands.filter((c) => c.name.startsWith('mcp:'))
  const other = commands.filter((c) => !c.name.startsWith('mcp:'))
  return [
    { title: 'Commands and skills', commands: other },
    { title: 'MCP prompts', commands: mcp }
  ].filter((g) => g.commands.length > 0)
}

export function StatusLine(props: Props): React.JSX.Element {
  const { session, live, git, devModel, runningThread } = props
  const [modelError, setModelError] = useState<string | null>(null)
  const usage = live.usage
  const pct = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null
  const model = live.model
  const current = model?.options.find((o) => o.value === model.current)
  const hasMcpCommand = live.commands.some((c) => c.name === 'mcp')

  return (
    <div className="status-line" role="status">
      {runningThread !== undefined &&
        (runningThread === null ? (
          <span className="status-item working">Working…</span>
        ) : (
          <button className="status-item working link" onClick={() => props.onOpenThread(runningThread)}>
            Working in {props.runningLabel ?? 'a thread'}
          </button>
        ))}
      {!live.attached && runningThread === undefined && <span className="status-item muted">Agent not running</span>}

      {pct !== null && usage && (
        <span
          className={`status-item context${pct >= 80 ? ' high' : ''}`}
          title={`Context: ${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens. Run /compact to free space.`}
        >
          <span className="meter" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
          {pct}% <span className="muted">of {formatTokens(usage.size)}</span>
        </span>
      )}
      {usage?.cost && (
        <span className="status-item" title="Session cost reported by the agent">
          {formatCost(usage.cost)}
        </span>
      )}

      {model &&
        (devModel ? (
          <span className="status-item" title="The dev model is on (Settings), so it overrides the model picked here.">
            Haiku (dev)
          </span>
        ) : (
          <Popover label={current?.name ?? model.current} title="Model">
            {(close) => (
              <ul className="option-list" role="listbox" aria-label="Model">
                {model.options.map((o) => (
                  <li key={o.value}>
                    <button
                      className={o.value === model.current ? 'on' : undefined}
                      role="option"
                      aria-selected={o.value === model.current}
                      onClick={() => {
                        close()
                        setModelError(null)
                        props.onSetModel(o.value).catch((err: unknown) => setModelError(err instanceof Error ? err.message : String(err)))
                      }}
                    >
                      <span>{o.name}</span>
                      {o.description && <span className="muted">{o.description}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        ))}
      {modelError && <span className="status-item error">{modelError}</span>}

      {live.permissions === 'bypass' && (
        <span className="status-item" title="The agent runs without permission prompts (its bypass mode).">
          bypass
        </span>
      )}
      {live.permissions === 'auto' && (
        <span
          className="status-item warn"
          title="The agent didn't switch to its bypass mode, so Gloss approves each permission request it makes."
        >
          auto-approving
        </span>
      )}

      {(live.commands.length > 0 || hasMcpCommand) && (
        <Popover label="Extensions" title="What the agent loaded">
          {(close) => (
            <div className="extensions">
              <p className="muted">The agent loads its own plugins, skills and MCP servers. Gloss shows what it reports.</p>
              {hasMcpCommand && (
                <button
                  className="extensions-mcp"
                  onClick={() => {
                    close()
                    props.onCommand('/mcp')
                  }}
                >
                  Show MCP server status
                </button>
              )}
              {groupCommands(live.commands).map((g) => (
                <section key={g.title}>
                  <div className="label">{g.title}</div>
                  <ul>
                    {g.commands.map((c) => (
                      <li key={c.name}>
                        <span className="mono">/{c.name}</span> <span className="muted">{c.description}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Popover>
      )}

      <span className="status-spacer" />
      {git && (
        <span className="status-item mono" title={git.dirty ? 'Uncommitted changes' : 'Clean working tree'}>
          {git.branch}
          {git.dirty && <span className="dirty">*</span>}
        </span>
      )}
      <span className="status-item mono" title={session.cwd}>
        {folderName(session.cwd)}
      </span>
    </div>
  )
}
