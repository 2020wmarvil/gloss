// The status line at the bottom of the conversation (SPEC → Status line). Everything
// but git details and the usage popup come from what the agent reports over ACP.
import { useState } from 'react'
import type { GitStatus, PullRequest } from '@shared/ipc'
import { folderName } from '@shared/paths'
import type { ConfigChoice, MessageQueue, ModelOption, RateLimit, Session, SessionLive, SlashCommand } from '@shared/types'
import { errorText } from './errors'
import { Popover } from './Popover'
import { UsagePanel } from './UsagePanel'

type Props = {
  session: Session
  live: SessionLive
  git: GitStatus | null
  pr: PullRequest | null
  /** A turn is running (the activity strip says where). */
  running: boolean
  queue: MessageQueue
  onResumeQueue(): void
  onSetChoice(kind: 'model' | 'effort', value: string): Promise<void>
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

const WINDOW_LABELS: Record<string, [short: string, long: string]> = {
  five_hour: ['5h', '5-hour limit'],
  seven_day: ['week', 'weekly limit'],
  seven_day_opus: ['week (Opus)', 'weekly Opus limit'],
  seven_day_sonnet: ['week (Sonnet)', 'weekly Sonnet limit'],
  seven_day_overage_included: ['week', 'weekly limit'],
  overage: ['extra', 'extra usage']
}

function formatReset(ms: number): string {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** One plan usage window: "5h ok", "5h 82%", or "5h limit · resets 3:40 PM". */
function RateLimitItem({ limit }: { limit: RateLimit }): React.JSX.Element {
  const [short, long] = WINDOW_LABELS[limit.window] ?? [limit.window, limit.window.replace(/_/g, ' ')]
  const reset = limit.resetsAt ? formatReset(limit.resetsAt) : null
  const text =
    limit.status === 'rejected'
      ? `${short} limit${reset ? ` · resets ${reset}` : ''}`
      : limit.utilization !== undefined
        ? `${short} ${limit.utilization}%`
        : `${short} ok`
  const title = [
    `Claude ${long}: ${
      limit.status === 'rejected'
        ? 'reached'
        : limit.utilization !== undefined
          ? `${limit.utilization}% used`
          : limit.status === 'warning'
            ? 'getting close'
            : 'within the limit'
    }.`,
    reset ? `Resets ${reset}.` : ''
  ]
    .filter(Boolean)
    .join(' ')
  const className = `status-item${limit.status === 'rejected' ? ' error' : limit.status === 'warning' ? ' warn' : ''}`
  return (
    <span className={className} title={title}>
      {text}
    </span>
  )
}

const CHECK_LABELS: Record<NonNullable<PullRequest['checks']>, string> = {
  passing: 'Checks passing',
  failing: 'Checks failing',
  pending: 'Checks running'
}

/** The branch's pull request: "#12 open" colored by state, with a dot for its checks. Opens it on GitHub. */
function PullRequestItem({ pr }: { pr: PullRequest }): React.JSX.Element {
  const title = [`#${pr.number} ${pr.title}`, pr.checks && `${CHECK_LABELS[pr.checks]}.`, pr.review && `Review: ${pr.review}.`, 'Click to open on GitHub.']
    .filter(Boolean)
    .join('\n')
  // External links open in the system browser (the main window's open handler).
  return (
    <a className={`status-item link pr ${pr.state}`} href={pr.url} target="_blank" rel="noreferrer" title={title}>
      {pr.checks && <span className={`pr-checks ${pr.checks}`} aria-label={CHECK_LABELS[pr.checks]} />}#{pr.number} {pr.state}
    </a>
  )
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

/**
 * What the status line calls a model: its name, except for an agent's `default`
 * option, whose description names the model it stands for (Claude Code:
 * "Default (recommended)", described as "Opus 5.5").
 */
export function modelLabel(option: ModelOption): string {
  return option.value === 'default' && option.description ? option.description : option.name
}

/** A popover listing a config option's values (the model or the effort); picking one sets it. */
function ChoicePicker(props: {
  label: string
  title: string
  choice: ConfigChoice
  onPick(value: string): void
}): React.JSX.Element {
  const { choice } = props
  return (
    <Popover label={props.label} title={props.title}>
      {(close) => (
        <ul className="option-list" role="listbox" aria-label={props.title}>
          {choice.options.map((o) => (
            <li key={o.value}>
              <button
                className={o.value === choice.current ? 'on' : undefined}
                role="option"
                aria-selected={o.value === choice.current}
                onClick={() => {
                  close()
                  props.onPick(o.value)
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
  )
}

export function StatusLine(props: Props): React.JSX.Element {
  const { session, live, git } = props
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const usage = live.usage
  const pct = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null
  const { model, effort } = live
  const currentModel = model?.options.find((o) => o.value === model.current)
  const currentEffort = effort?.options.find((o) => o.value === effort.current)
  const pick = (kind: 'model' | 'effort') => (value: string) => {
    setChoiceError(null)
    props.onSetChoice(kind, value).catch((err: unknown) => setChoiceError(errorText(err)))
  }
  const hasMcpCommand = live.commands.some((c) => c.name === 'mcp')
  const usageLabel = <>
    {pct !== null && usage && (
      <span className={`status-item context${pct >= 80 ? ' high' : ''}`}>
        <span className="meter" aria-hidden><span style={{ width: `${pct}%` }} /></span>
        {pct}% <span className="muted">of {formatTokens(usage.size)}</span>
      </span>
    )}
    {usage?.cost && <span className="status-item">{formatCost(usage.cost)}</span>}
    {live.rateLimits.map((l) => <RateLimitItem key={l.window} limit={l} />)}
  </>

  return (
    <div className="status-line" role="status">
      {!live.attached && !props.running && <span className="status-item muted">Agent not running</span>}
      {props.queue.items.length > 0 &&
        (props.queue.paused ? (
          <button className="status-item paused" onClick={props.onResumeQueue} title="Send the next queued message">
            {props.queue.items.length} queued, paused · Resume
          </button>
        ) : (
          <span className="status-item queue-count">{props.queue.items.length} queued</span>
        ))}

      {session.agentId === 'claude' ? (
        <Popover key={session.id} label={pct !== null || usage?.cost || live.rateLimits.length ? usageLabel : 'Usage'}
          title="Usage details" className="status-item usage-trigger">
          {() => <UsagePanel sessionId={session.id} context={usage} />}
        </Popover>
      ) : usageLabel}

      {model && (
        <ChoicePicker label={currentModel ? modelLabel(currentModel) : model.current} title="Model" choice={model} onPick={pick('model')} />
      )}
      {effort && (
        <ChoicePicker
          label={currentEffort?.name ?? effort.current}
          title="Effort"
          // Gloss replaces Claude's "default" with a real level, so it isn't offered (unless that failed).
          choice={{ ...effort, options: effort.options.filter((o) => o.value !== 'default' || o.value === effort.current) }}
          onPick={pick('effort')}
        />
      )}
      {choiceError && <span className="status-item error">{choiceError}</span>}

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
      {props.pr && <PullRequestItem pr={props.pr} />}
      {git &&
        (git.url ? (
          <a
            className="status-item link mono"
            href={git.url}
            target="_blank"
            rel="noreferrer"
            title={`${git.dirty ? 'Uncommitted changes' : 'Clean working tree'}. Click to open the branch on GitHub.`}
          >
            {git.branch}
            {git.dirty && <span className="dirty">*</span>}
          </a>
        ) : (
          <span className="status-item mono" title={git.dirty ? 'Uncommitted changes' : 'Clean working tree'}>
            {git.branch}
            {git.dirty && <span className="dirty">*</span>}
          </span>
        ))}
      <button
        className="status-item mono"
        title={`${session.cwd}\nClick to open the folder.`}
        onClick={() => {
          setFolderError(null)
          void window.gloss.sessions.openFolder(session.id).then(setFolderError, (err: unknown) => setFolderError(errorText(err)))
        }}
      >
        {folderName(session.cwd)}
      </button>
      {folderError && <span className="status-item error">Couldn&apos;t open the folder: {folderError}</span>}
    </div>
  )
}
