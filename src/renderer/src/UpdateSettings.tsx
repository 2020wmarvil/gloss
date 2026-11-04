// Settings > General's Gloss group: the version, its update state and the Automatic updates switch
// (docs/mocks/updates.html, SPEC → Shipping).
import type { UpdateState } from '@shared/ipc'
import { Switch } from './Select'
import { ago } from './Sidebar'

function stateText(state: UpdateState, now: number): string {
  switch (state.status) {
    case 'unsupported':
      return state.reason === 'mac' ? 'Download new versions from the releases page.' : 'Development build. Only installed copies update.'
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading ${state.next}…`
    case 'ready':
      return `${state.next} is downloaded and installs when you restart.`
    case 'error':
      return state.error ?? "Couldn't update Gloss. Try again later."
    case 'current': {
      if (!state.checkedAt) return 'Up to date.'
      const when = ago(state.checkedAt, now)
      return `Up to date. Checked ${when === 'now' ? 'just now' : `${when} ago`}.`
    }
    default:
      return 'Not checked yet.'
  }
}

export function UpdateSettings(props: {
  state: UpdateState
  automatic: boolean
  onAutomatic(on: boolean): void
  now?: number
}): React.JSX.Element {
  const { state } = props
  const check = (label = 'Check for updates'): React.JSX.Element => (
    <button className="secondary sm" disabled={state.status === 'unsupported'} onClick={() => void window.gloss.updates.check()}>{label}</button>
  )
  return (
    <>
      <h3 className="settings-group-title">Gloss</h3>
      <div className="settings-card">
        <div className="setting">
          <div className="setting-copy">
            <span className="setting-label">Version {state.version}</span>
            <p className="setting-desc" role="status">{stateText(state, props.now ?? Date.now())}</p>
          </div>
          <div className="update-control">
            {state.status === 'checking' ? <button className="secondary sm" disabled>Checking…</button>
              : state.status === 'downloading' ? (
                <span className="update-progress">
                  <span className="update-bar" role="progressbar" aria-label="Download progress" aria-valuenow={state.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                    <i style={{ width: `${state.percent ?? 0}%` }} />
                  </span>
                  {state.percent ?? 0}%
                </span>
              ) : state.status === 'ready' ? <button className="primary sm" onClick={() => void window.gloss.updates.restart()}>Restart to update</button>
                : state.status === 'error' ? check('Try again')
                  : check()}
          </div>
        </div>
        <div className="setting">
          <div className="setting-copy">
            <label className="setting-label" htmlFor="setting-autoUpdate">Automatic updates</label>
            <p className="setting-desc" id="setting-autoUpdate-description">Check for updates and download them in the background.</p>
          </div>
          <Switch id="setting-autoUpdate" ariaLabel="Automatic updates" ariaDescribedBy="setting-autoUpdate-description"
            checked={props.automatic} disabled={state.status === 'unsupported'} onChange={props.onAutomatic} />
        </div>
      </div>
    </>
  )
}
