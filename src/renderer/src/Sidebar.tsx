import type { Session } from '@shared/types'

type Props = {
  sessions: Session[]
  openId: string | null
  running: Record<string, string | null>
  creating: boolean
  createError: string | null
  settingsOpen: boolean
  /** settings.json's last edit was rejected. */
  settingsError: boolean
  onSelect(id: string): void
  onNew(): void
  onSettings(): void
}

export function Sidebar(props: Props): React.JSX.Element {
  const { sessions, openId, running, creating, createError, settingsOpen, settingsError } = props
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
      <button
        className={settingsOpen ? 'settings-button on' : 'settings-button'}
        onClick={props.onSettings}
        title="Settings (Ctrl+,)"
      >
        Settings
        {settingsError && (
          <span className="settings-alert" title="settings.json has a problem">
            !
          </span>
        )}
      </button>
    </nav>
  )
}
