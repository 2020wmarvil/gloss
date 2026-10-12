import { useEffect, useRef, useState, type ReactNode } from 'react'

type Props = {
  className: string
  placeholder: string
  /** A turn is running somewhere in the session: Send is disabled everywhere. */
  running: boolean
  autoFocus?: boolean
  footer?: ReactNode
  onSend(text: string): void
  onCancel(): void
}

export function Composer({
  className,
  placeholder,
  running,
  autoFocus,
  footer,
  onSend,
  onCancel
}: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus && !running) ref.current?.focus()
  }, [autoFocus, running])

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed || running) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className={className}>
      <div className="box">
        <textarea
          ref={ref}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={placeholder}
          aria-label={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button className="cancel" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button className="primary send" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
      {footer}
    </div>
  )
}
