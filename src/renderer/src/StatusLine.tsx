// The status line at the bottom of the conversation (SPEC → Status line). Everything
// but git details and the usage popup come from what the agent reports over ACP.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GitStatus, PullRequest } from '@shared/ipc'
import { folderName } from '@shared/paths'
import type { ConfigChoice, MessageQueue, ModelOption, RateLimit, Session, SessionLive, SessionModes, SlashCommand } from '@shared/types'
import { errorText } from './errors'
import { Popover } from './Popover'
import { UsagePanel } from './UsagePanel'
import { Check, ChevronDown, Cpu, Gauge, Folder, GitBranch, Hand, Puzzle, Shield, ShieldAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react'

type Props = {
  session: Session
  live: SessionLive
  git: GitStatus | null
  pr: PullRequest | null
  obsidianVault?: string
  /** A turn is running (the activity strip says where). */
  running: boolean
  /** Questions and approvals the agent is waiting on the user for. */
  waiting?: number
  queue: MessageQueue
  /** An activity strip above already counts the queued messages. */
  queueShownAbove?: boolean
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

/** 200000 → "200k", 1000000 → "1M". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

const WINDOW_LABELS: Record<string, [short: string, long: string]> = {
  five_hour: ['5h limit', '5-hour limit'],
  overage: ['Extra usage', 'extra usage']
}

function formatReset(ms: number): string {
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

/** One plan usage window: "5h limit OK", "5h limit 82%", or "5h limit reached · resets 3:40 PM". */
function RateLimitItem({ limit }: { limit: RateLimit }): React.JSX.Element {
  const [short, long] = WINDOW_LABELS[limit.window] ?? [limit.window, limit.window.replace(/_/g, ' ')]
  const reset = limit.resetsAt ? formatReset(limit.resetsAt) : null
  const value =
    limit.status === 'rejected'
      ? `reached${reset ? ` · resets ${reset}` : ''}`
      : limit.utilization !== undefined
        ? `${limit.utilization}%`
        : 'OK'
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
      <span className="status-label">{short}</span>
      {value}
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

/** Agents' raw option names made readable ("Xhigh" is Claude's extra-high effort). */
export function optionName(name: string): string {
  return /^x-?high$/i.test(name) ? 'Extra high' : name
}

/** A description without the option's name repeated at its start ("Opus 5.5 · Best for…" under "Opus 5.5"). */
export function optionDescription(name: string, description?: string | null): string | null {
  if (!description) return null
  const rest = description.startsWith(name) ? description.slice(name.length).replace(/^\s*[·:-]\s*/, '') : description
  return rest.trim() || null
}

/** A popover listing a config option's values (the model or the effort); picking one sets it. */
function ChoicePicker(props: {
  label: string
  icon: React.JSX.Element
  title: string
  choice: ConfigChoice
  onPick(value: string): void
}): React.JSX.Element {
  const { choice } = props
  return (
    <Popover
      label={<>{props.icon}{props.label}<ChevronDown className="status-chevron" aria-hidden /></>}
      title={props.title}
      className="status-item status-button"
    >
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
                <Check className="option-check" />
                <span>{optionName(o.name)}</span>
                {optionDescription(o.name, o.description) && <span className="muted">{optionDescription(o.name, o.description)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  )
}

/**
 * The session's permission mode (SPEC → Permission modes): the agent's modes, and for an
 * agent without a bypass mode, Gloss's own auto-approval. Amber while Gloss approves.
 */
function ModePicker(props: {
  modes: SessionModes | null
  autoApprove: boolean
  onPickMode(modeId: string): void
  onAutoApprove(on: boolean): void
}): React.JSX.Element {
  const { modes, autoApprove } = props
  const current = modes?.options.find((o) => o.value === modes.current)
  const glossApproves = autoApprove && !modes?.bypass
  const Icon = glossApproves ? ShieldAlert : autoApprove ? ShieldCheck : Shield
  const label = current ? optionName(current.name) : autoApprove ? 'Auto-approve' : 'Ask'
  const title = autoApprove
    ? glossApproves
      ? 'Permission mode. Gloss approves each request the agent makes.'
      : 'Permission mode. The agent runs tools without asking.'
    : 'Permission mode. The agent asks before acting where this mode says so.'
  return (
    <Popover
      label={<><Icon className="status-icon" aria-hidden />{label}{glossApproves && modes && <span className="status-label">· auto-approve</span>}<ChevronDown className="status-chevron" aria-hidden /></>}
      title={title}
      className={`status-item status-button mode-picker${glossApproves ? ' warn' : ''}`}
    >
      {(close) => (
        <>
          {modes && (
            <ul className="option-list" role="listbox" aria-label="Permission mode">
              {modes.options.map((o) => (
                <li key={o.value}>
                  <button
                    className={o.value === modes.current ? 'on' : undefined}
                    role="option"
                    aria-selected={o.value === modes.current}
                    onClick={() => {
                      close()
                      props.onPickMode(o.value)
                    }}
                  >
                    <Check className="option-check" />
                    <span>{optionName(o.name)}</span>
                    {optionDescription(o.name, o.description) && <span className="muted">{optionDescription(o.name, o.description)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!modes?.bypass && (
            <ul className="option-list" aria-label="Approval">
              <li>
                <button
                  className={autoApprove ? 'on' : undefined}
                  role="menuitemcheckbox"
                  aria-checked={autoApprove}
                  onClick={() => {
                    close()
                    props.onAutoApprove(!autoApprove)
                  }}
                >
                  <Check className="option-check" />
                  <span>Approve requests automatically</span>
                  <span className="muted">Gloss answers the agent&apos;s permission requests with allow once.</span>
                </button>
              </li>
            </ul>
          )}
        </>
      )}
    </Popover>
  )
}

/**
 * Hides the children of a wrapping row that don't fit on its first line, so items drop out
 * from the right as the pane narrows. Hidden rather than clipped: a clipping box would cut
 * off the items' popovers too.
 */
function useFirstLineOnly(): React.RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const row = ref.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const fit = (): void => {
      const items = [...row.children] as HTMLElement[]
      for (const el of items) el.style.visibility = ''
      const top = items[0]?.offsetTop ?? 0
      for (const el of items) if (el.offsetTop > top) el.style.visibility = 'hidden'
    }
    fit()
    const resized = new ResizeObserver(fit)
    resized.observe(row)
    const changed = new MutationObserver(fit)
    changed.observe(row, { childList: true, subtree: true, characterData: true })
    return () => {
      resized.disconnect()
      changed.disconnect()
    }
  }, [])
  return ref
}

export function StatusLine(props: Props): React.JSX.Element {
  const { session, live, git } = props
  const agentItems = useFirstLineOnly()
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [obsidianError, setObsidianError] = useState<string | null>(null)
  useEffect(() => setObsidianError(null), [session.id, props.obsidianVault])
  const usage = live.usage
  const statusLimits = live.rateLimits.filter((limit) => !/^seven_day(?:_|$)/.test(limit.window))
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
        <span className="status-label">Context</span>
        <span className="meter" aria-hidden><span style={{ width: `${pct}%` }} /></span>
        {pct}% <span className="status-label">of {formatTokens(usage.size)}</span>
      </span>
    )}
    {usage?.cost && <span className="status-item" title="What this session has cost so far">{formatCost(usage.cost)}</span>}
    {statusLimits.map((l) => <RateLimitItem key={l.window} limit={l} />)}
  </>

  return (
    <div className="status-line" role="status">
      {/* What the agent reports, in order of importance. */}
      <span className="status-agent" ref={agentItems}>
        {!live.attached && !props.running && <span className="status-item muted">Agent not running</span>}
        {(props.waiting ?? 0) > 0 && (
          <span className="status-item waiting" title="The agent is waiting for your answer in the conversation">
            <Hand className="status-icon" aria-hidden />
            Waiting for you
          </span>
        )}
        {props.queue.items.length > 0 &&
          (props.queue.paused ? (
            <button className="status-item paused" onClick={props.onResumeQueue} title="Send the next queued message">
              {props.queue.items.length} queued, paused · Resume
            </button>
          ) : (
            !props.queueShownAbove && <span className="status-item queue-count">{props.queue.items.length} queued</span>
          ))}

        {session.agentId === 'claude' || session.agentId === 'codex' ? (
          <Popover key={session.id} label={pct !== null || usage?.cost || statusLimits.length ? usageLabel : <><Gauge className="status-icon" aria-hidden />Usage</>}
            title="Usage details" className="status-item status-button usage-trigger">
            {() => <UsagePanel sessionId={session.id} context={usage} />}
          </Popover>
        ) : usageLabel}

        {model && (
          <ChoicePicker
            label={currentModel ? modelLabel(currentModel) : model.current}
            icon={<Cpu className="status-icon" aria-hidden />}
            title="Model"
            choice={model}
            onPick={pick('model')}
          />
        )}
        {effort && (
          <ChoicePicker
            label={optionName(currentEffort?.name ?? effort.current)}
            icon={<SlidersHorizontal className="status-icon" aria-hidden />}
            title="Effort"
            // Gloss replaces Claude's "default" with a real level, so it isn't offered (unless that failed).
            choice={{ ...effort, options: effort.options.filter((o) => o.value !== 'default' || o.value === effort.current) }}
            onPick={pick('effort')}
          />
        )}

        {live.attached && (
          <ModePicker
            modes={live.modes}
            autoApprove={live.autoApprove}
            onPickMode={(modeId) => {
              setChoiceError(null)
              window.gloss.sessions.setMode(session.id, modeId).catch((err: unknown) => setChoiceError(errorText(err)))
            }}
            onAutoApprove={(on) => {
              setChoiceError(null)
              window.gloss.sessions.setAutoApprove(session.id, on).catch((err: unknown) => setChoiceError(errorText(err)))
            }}
          />
        )}

        {(live.commands.length > 0 || hasMcpCommand) && (
          <Popover
            label={<><Puzzle className="status-icon" aria-label="Extensions" /><ChevronDown className="status-chevron" aria-hidden /></>}
            title="Extensions: what the agent loaded"
            className="status-item status-button"
          >
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

      </span>

      {/* Where the session works, at the right end: folder, branch, pull request. Names shorten first. */}
      <span className="status-place">
        <button
          className="status-item folder"
          title={`${session.cwd}\nClick to open the folder.`}
          onClick={() => {
            setFolderError(null)
            void window.gloss.sessions.openFolder(session.id).then(setFolderError, (err: unknown) => setFolderError(errorText(err)))
          }}
        >
          <Folder className="status-icon" aria-hidden />
          <span className="status-name">{folderName(session.cwd)}</span>
        </button>
        {git &&
          (git.url ? (
            <a
              className="status-item link branch"
              href={git.url}
              target="_blank"
              rel="noreferrer"
              title={`${git.dirty ? 'Uncommitted changes' : 'Clean working tree'}. Click to open the branch on GitHub.`}
            >
              <GitBranch className="status-icon" aria-hidden />
              <span className="status-name">{git.branch}</span>
              {git.dirty && <span className="dirty">*</span>}
            </a>
          ) : (
            <span className="status-item branch" title={git.dirty ? 'Uncommitted changes' : 'Clean working tree'}>
              <GitBranch className="status-icon" aria-hidden />
              <span className="status-name">{git.branch}</span>
              {git.dirty && <span className="dirty">*</span>}
            </span>
          ))}
        {props.pr && <PullRequestItem pr={props.pr} />}
        {props.obsidianVault?.trim() && (
          <button className="status-item" title={`Open Obsidian vault: ${props.obsidianVault.trim()}`}
            aria-label="Open Obsidian vault"
            onClick={() => {
              setObsidianError(null)
              void window.gloss.sessions.openObsidian(session.id).catch((err: unknown) => setObsidianError(errorText(err)))
            }}>
            <img src={new URL('./assets/obsidian-logo.svg', import.meta.url).href}
              width="14" height="14" alt="" aria-hidden="true" />
          </button>
        )}
      </span>
      {choiceError && <span className="status-item error">{choiceError}</span>}
      {obsidianError && <span className="status-item error">Couldn&apos;t open Obsidian: {obsidianError}</span>}
      {folderError && <span className="status-item error">Couldn&apos;t open the folder: {folderError}</span>}
    </div>
  )
}
