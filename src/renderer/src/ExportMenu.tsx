import { Popover } from './Popover'
import { Share } from 'lucide-react'

const exportIcon = <Share />

/** Copy or save a session or thread as markdown; disabled while there's nothing to export. */
export function ExportMenu(props: { label: 'session' | 'thread'; disabled?: boolean; onCopy(): void; onSave(): void }): React.JSX.Element {
  return (
    <Popover
      label={exportIcon}
      title={props.disabled ? 'Nothing to export yet' : `Export this ${props.label} as markdown`}
      className="header-button icon"
      disabled={props.disabled}
      down
    >
      {(close) => (
        <ul className="option-list">
          <li>
            <button onClick={() => (close(), props.onCopy())}>Copy as markdown</button>
          </li>
          <li>
            <button onClick={() => (close(), props.onSave())}>Save as markdown…</button>
          </li>
        </ul>
      )}
    </Popover>
  )
}
