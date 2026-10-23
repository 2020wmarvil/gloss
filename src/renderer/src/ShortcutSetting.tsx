// A key combination setting (SPEC → Visual feedback → capture shortcut), as shortcut fields in
// other apps work: one field, the same width as the other settings' controls. Click it (or press
// Enter on it) and press the keys; Backspace or Delete clears it, Esc keeps what was there.
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

export function ShortcutSetting(props: { id: string; value: string; onChange(value: string): void }): React.JSX.Element {
  const { id, value, onChange } = props
  const [recording, setRecording] = useState(false)
  /** The modifiers held so far while recording. */
  const [held, setHeld] = useState<string[]>([])
  /** Why the last key press couldn't be a shortcut, while recording. */
  const [hint, setHint] = useState<string | null>(null)
  /** Why the shortcut isn't working (another app has it), from the main process. */
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef(false)

  useEffect(() => {
    let current = true
    if (!recording) void window.gloss?.capture?.shortcutStatus().then((s) => current && setError(s.error))
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

  function setRecordingTo(on: boolean): void {
    setRecording(on)
    recordingRef.current = on
    setHeld([])
    setHint(null)
    // The current shortcut would take the keys before they reach this field.
    void window.gloss?.capture?.pauseShortcut(on)
  }

  function save(next: string): void {
    setRecordingTo(false)
    if (next !== value) onChange(next)
  }

  function onKey(e: React.KeyboardEvent, up: boolean): void {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    const press = e.nativeEvent
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    if (!up && plain && e.key === 'Escape') return setRecordingTo(false)
    if (!up && plain && (e.key === 'Backspace' || e.key === 'Delete')) return save('')
    // Windows sends no keydown for PrintScreen, only its keyup.
    if (up && press.code !== 'PrintScreen') return setHeld(heldModifiers(press).map((m) => shortcutKeys(m, MAC)[0]))
    const result = shortcutFromKey(press)
    if (result === null) setHeld(heldModifiers(press).map((m) => shortcutKeys(m, MAC)[0]))
    else if ('error' in result) setHint(result.error)
    else save(result.accelerator)
  }

  const note = recording ? hint : error
  return (
    <div className="shortcut-setting">
      <button
        id={id}
        type="button"
        className={`shortcut-field${recording ? ' recording' : ''}`}
        aria-describedby={`${id}-description`}
        aria-label={recording ? 'Press the new shortcut' : `Capture shortcut: ${value ? shortcutKeys(value, MAC).join(' ') : 'none'}`}
        onClick={() => !recording && setRecordingTo(true)}
        onKeyDown={(e) => onKey(e, false)}
        onKeyUp={(e) => onKey(e, true)}
        onBlur={() => recording && setRecordingTo(false)}
      >
        {recording ? (
          held.length > 0 ? <Keys keys={held} /> : <span className="shortcut-placeholder">Press keys…</span>
        ) : value ? (
          <Keys keys={shortcutKeys(value, MAC)} />
        ) : (
          <span className="shortcut-placeholder">None</span>
        )}
      </button>
      {note && <p className={recording ? 'shortcut-note' : 'shortcut-note error'}>{note}</p>}
    </div>
  )
}
