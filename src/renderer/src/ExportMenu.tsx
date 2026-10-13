import { Popover } from './Popover'

/** Copy or save a session or thread as markdown. */
export function ExportMenu(props: { label: 'session' | 'thread'; onCopy(): void; onSave(): void }): React.JSX.Element {
  return (
    <Popover label="Export" title={`Export this ${props.label} as markdown`} className="header-button" down>
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
