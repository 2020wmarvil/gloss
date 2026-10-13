import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment, SlashCommand } from '@shared/types'

type Props = {
  className: string
  placeholder: string
  /** A turn is running somewhere in the session: Send is disabled everywhere. */
  running: boolean
  autoFocus?: boolean
  /** Focus on the app's "focus composer" shortcut. */
  primary?: boolean
  footer?: ReactNode
  /** The agent's slash commands, offered after a leading "/". */
  commands: SlashCommand[]
  /** What the agent accepts besides text. */
  accepts: { image: boolean; file: boolean }
  onSend(text: string, attachments: Attachment[]): void
  onCancel(): void
}

export const FOCUS_COMPOSER = 'gloss:focus-composer'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

/** Turns a pasted, dropped or picked file into an attachment the agent accepts, or explains why not. */
async function toAttachment(file: File, accepts: Props['accepts']): Promise<Attachment> {
  const name = file.name || 'pasted'
  if (file.type.startsWith('image/')) {
    if (!accepts.image) throw new Error("The agent doesn't accept images.")
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${name} is larger than 10 MB.`)
    const url = await readDataUrl(file)
    return { kind: 'image', name, mimeType: file.type, data: url.slice(url.indexOf(',') + 1) }
  }
  if (!accepts.file) throw new Error("The agent doesn't accept attached files.")
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is larger than 1 MB.`)
  const text = await file.text()
  if (text.includes('\0')) throw new Error(`${name} isn't a text file.`)
  const path = window.gloss.files.pathFor(file)
  return { kind: 'file', name, text, ...(path ? { path } : {}), ...(file.type ? { mimeType: file.type } : {}) }
}

export function Composer({
  className,
  placeholder,
  running,
  autoFocus,
  primary,
  footer,
  commands,
  accepts,
  onSend,
  onCancel
}: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus && !running) ref.current?.focus()
  }, [autoFocus, running])

  useEffect(() => {
    if (!primary) return
    const focus = (): void => ref.current?.focus()
    window.addEventListener(FOCUS_COMPOSER, focus)
    return () => window.removeEventListener(FOCUS_COMPOSER, focus)
  }, [primary])

  // Slash commands: offered while the text is a single "/word" at the start.
  const slash = /^\/(\S*)$/.exec(text)
  const matches =
    slash && dismissed !== text
      ? commands.filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase())).slice(0, 8)
      : []
  const picked = matches.length > 0 ? Math.min(pick, matches.length - 1) : 0

  function choose(c: SlashCommand): void {
    setText(`/${c.name} `)
    setPick(0)
    ref.current?.focus()
  }

  async function addFiles(files: File[]): Promise<void> {
    setError(null)
    for (const file of files) {
      try {
        const a = await toAttachment(file, accepts)
        setAttachments((list) => [...list, a])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  function submit(): void {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || running) return
    onSend(trimmed, attachments)
    setText('')
    setAttachments([])
    setError(null)
  }

  const canAttach = accepts.image || accepts.file

  return (
    <div className={className}>
      {matches.length > 0 && (
        <ul className="slash-menu" role="listbox" aria-label="Slash commands">
          {matches.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === picked}>
              <button
                className={i === picked ? 'on' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c)}
              >
                <span className="slash-name">/{c.name}</span>
                {c.hint && <span className="slash-hint">{c.hint}</span>}
                <span className="slash-desc">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={`box${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          if (!canAttach || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (canAttach) void addFiles([...e.dataTransfer.files])
        }}
      >
        {attachments.length > 0 && (
          <ul className="attachments">
            {attachments.map((a, i) => (
              <li key={i} className="attachment" title={a.kind === 'file' ? (a.path ?? a.name) : a.name}>
                {a.kind === 'image' ? (
                  <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                ) : (
                  <span className="attachment-name">{a.name}</span>
                )}
                <button
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="box-row">
          {canAttach && (
            <>
              <button
                className="attach"
                aria-label="Attach files"
                title={accepts.image && accepts.file ? 'Attach images or files' : accepts.image ? 'Attach images' : 'Attach files'}
                onClick={() => fileInput.current?.click()}
              >
                +
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={accepts.file ? undefined : 'image/*'}
                onChange={(e) => {
                  void addFiles([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </>
          )}
          <textarea
            ref={ref}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            placeholder={placeholder}
            aria-label={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setPick(0)
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.length === 0) return
              e.preventDefault()
              if (canAttach) void addFiles(files)
              else setError("The agent doesn't accept images or files.")
            }}
            onKeyDown={(e) => {
              if (matches.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setPick((picked + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
                  return
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  // Enter on an exact match sends it; otherwise it completes.
                  if (!(e.key === 'Enter' && matches[picked].name === slash?.[1])) {
                    e.preventDefault()
                    choose(matches[picked])
                    return
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setDismissed(text)
                  return
                }
              }
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
            <button className="primary send" onClick={submit} disabled={!text.trim() && attachments.length === 0}>
              Send
            </button>
          )}
        </div>
      </div>
      {error && <p className="composer-error">{error}</p>}
      {footer}
    </div>
  )
}
