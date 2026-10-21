// A dropdown that opens the app's own menu instead of the OS one, and a switch in place
// of a checkbox (docs/mocks/design-system.html → Inputs and controls).
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type SelectOption = { value: string; label: string; disabled?: boolean }

export function Select(props: {
  value: string
  options: SelectOption[]
  onChange(value: string): void
  id?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  disabled?: boolean
}): React.JSX.Element {
  const { value, options, onChange } = props
  const [open, setOpen] = useState(false)
  /** The highlighted option while open: arrows move it, Enter picks it. */
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  function show(): void {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  function pick(o: SelectOption): void {
    if (o.disabled) return
    setOpen(false)
    if (o.value !== value) onChange(o.value)
  }

  /** The next enabled option from `from` in direction `dir`, wrapping around. */
  function step(from: number, dir: 1 | -1): number {
    for (let i = 1; i <= options.length; i++) {
      const j = (from + dir * i + options.length) % options.length
      if (!options[j].disabled) return j
    }
    return from
  }

  return (
    <span className="select" ref={ref}>
      <button
        type="button"
        id={props.id}
        className="select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.ariaLabel}
        aria-describedby={props.ariaDescribedBy}
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              show()
            }
            return
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => step(a, e.key === 'ArrowDown' ? 1 : -1))
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            pick(options[active])
          } else if (e.key === 'Escape') {
            // Closes the menu, not the dialog or screen around it.
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          } else if (e.key === 'Tab') {
            setOpen(false)
          }
        }}
      >
        <span className="select-value">{current?.label ?? value}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <ul className="select-menu" role="listbox" aria-label={props.ariaLabel}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={i === active ? 'active' : undefined}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              <Check className="select-check" size={14} />
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}

export function Switch(props: {
  checked: boolean
  onChange(checked: boolean): void
  id?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      className="switch"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  )
}
