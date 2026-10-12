import type { Settings } from '@shared/ipc'
import type { Session } from '@shared/types'

type Props = {
  sessions: Session[]
  openId: string | null
  running: Record<string, string | null>
  creating: boolean
  createError: string | null
  settings: Settings | null
  onSelect(id: string): void
  onNew(): void
  onToggleDevModel(on: boolean): void
}

export function Sidebar(props: Props): React.JSX.Element {
  const { sessions, openId, running, creating, createError, settings } = props
  return (
    <nav className="sidebar">
      <div className="brand">gloss.</div>
      <button className="new-session" onClick={props.onNew} disabled={creating}>
        {creating ? 'Starting agent…' : '+ New session'}
      </button>
      {createError && <p className="sidebar-error">{createError}</p>}
      <div className="label">Sessions</div>
      <ul className="session-list">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              className={s.id === openId ? 'on' : undefined}
              onClick={() => props.onSelect(s.id)}
              title={s.cwd}
            >
              <span className="session-title">{s.title}</span>
              {s.id in running && <span className="running-dot" aria-label="Running" />}
            </button>
          </li>
        ))}
      </ul>
      <label className="dev-toggle" title="Spawn agents with ANTHROPIC_MODEL=haiku">
        <input
          type="checkbox"
          checked={settings?.devModel ?? false}
          disabled={settings === null}
          onChange={(e) => props.onToggleDevModel(e.target.checked)}
        />
        Dev model (Haiku)
      </label>
    </nav>
  )
}
