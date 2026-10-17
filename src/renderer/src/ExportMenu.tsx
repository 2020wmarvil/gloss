import { Popover } from './Popover'

const exportIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <path d="M16 6l-4-4-4 4" />
    <path d="M12 2v13" />
  </svg>
)

/** Copy or save a session or thread as markdown. */
export function ExportMenu(props: { label: 'session' | 'thread'; onCopy(): void; onSave(): void }): React.JSX.Element {
  return (
    <Popover label={exportIcon} title={`Export this ${props.label} as markdown`} className="header-button icon" down>
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
