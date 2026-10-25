import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A button that opens a small panel; clicks outside and Escape close it. */
export function Popover(props: {
  label: ReactNode
  title?: string
  /** Opens downward (in headers) instead of upward (in the status line). */
  down?: boolean
  className?: string
  disabled?: boolean
  children(close: () => void): ReactNode
}): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (e.target instanceof Node && !anchor.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('click', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <span ref={anchor} className="popover-anchor" onClick={(e) => e.stopPropagation()}>
      <button
        className={props.className ?? 'status-item link'}
        title={props.title}
        disabled={props.disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {props.label}
      </button>
      {open && <div className={props.down ? 'popover down' : 'popover'}>{props.children(() => setOpen(false))}</div>}
    </span>
  )
}
