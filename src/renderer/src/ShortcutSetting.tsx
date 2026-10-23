// A key combination setting (SPEC → Visual feedback → capture shortcut): click it, press the
// keys, and it records them as a clean shortcut, as shortcut fields in other apps do. Esc cancels.
import { useEffect, useRef, useState } from 'react'
import { heldModifiers, shortcutFromKey, shortcutKeys } from '@shared/shortcut'

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

function Keys({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <span className="shortcut-keys">
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  )
}

export function ShortcutSetting(props: { id: string; value: string; defaultValue: string; onChange(value: string): void }): React.JSX.Element {
  const { id, value, defaultValue, onChange } = props
  const [recording, setRecording] = useState(false)
  /** The modifiers held so far while recording. */
  const [held, setHeld] = useState<string[]>([])
  const [hint, setHint] = useState<string | null>(null)
  /** Why the shortcut isn't working (another app has it), from the main process. */
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLButtonElement>(null)
  const recordingRef = useRef(false)

  useEffect(() => {
    let current = true
    if (!recording) {
      void window.gloss?.capture?.shortcutStatus().then((s) => current && setError(s.error))
    }
    return () => {
      current = false
    }
  }, [value, recording])

  // Don't leave the shortcut paused if the screen closes mid-recording.
  useEffect(
    () => () => {
      if (recordingRef.current) void window.gloss?.capture?.pauseShortcut(false)
    },
    []
  )

  function start(): void {
    setHint(null)
    setHeld([])
    setRecording(true)
    recordingRef.current = true
    // The current shortcut would take the keys before they reach this field.
    void window.gloss?.capture?.pauseShortcut(true)
    box.current?.focus()
  }

  function stop(): void {
    setRecording(false)
    recordingRef.current = false
    setHeld([])
    void window.gloss?.capture?.pauseShortcut(false)
  }

  function onKey(e: React.KeyboardEvent, up: boolean): void {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    const press = e.nativeEvent
    if (!up && e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      setHint(null)
      stop()
      return
    }
    // Windows sends no keydown for PrintScreen, only its keyup.
    if (up && press.code !== 'PrintScreen') {
      setHeld(heldModifiers(press).map((m) => shortcutKeys(m, MAC)[0]))
      return
    }
    const result = shortcutFromKey(press)
    if (result === null) {
      setHeld(heldModifiers(press).map((m) => shortcutKeys(m, MAC)[0]))
    } else if ('error' in result) {
      setHint(result.error)
    } else {
      setHint(null)
      stop()
      if (result.accelerator !== value) onChange(result.accelerator)
    }
  }

  return (
    <div className="shortcut-setting">
      <div className="shortcut-row">
        <button
          ref={box}
          id={id}
          type="button"
          className={`shortcut-box${recording ? ' recording' : ''}`}
          aria-describedby={`${id}-description`}
          aria-label={recording ? 'Press the new shortcut, or Esc to cancel' : `Capture shortcut: ${value ? shortcutKeys(value, MAC).join(' ') : 'off'}. Click to change`}
          title={recording ? 'Esc cancels' : 'Click, then press the keys'}
          onClick={() => !recording && start()}
          onKeyDown={(e) => onKey(e, false)}
          onKeyUp={(e) => onKey(e, true)}
          onBlur={() => recording && stop()}
        >
          {recording ? (
            held.length > 0 ? (
              <>
                <Keys keys={held} />
                <span className="muted">…</span>
              </>
            ) : (
              <span className="muted">Press the keys…</span>
            )
          ) : value ? (
            <Keys keys={shortcutKeys(value, MAC)} />
          ) : (
            <span className="muted">Off</span>
          )}
        </button>
        {!recording && value && (
          <button type="button" className="ghost sm" onClick={() => onChange('')}>
            Turn off
          </button>
        )}
        {!recording && value !== defaultValue && (
          <button type="button" className="ghost sm" onClick={() => onChange(defaultValue)}>
            Reset
          </button>
        )}
      </div>
      {(hint ?? (!recording && error)) && <p className="shortcut-note">{hint ?? error}</p>}
    </div>
  )
}
