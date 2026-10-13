import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment, QueuedMessage, SlashCommand } from '@shared/types'
import { errorText } from './errors'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'

/** The session's queue as one composer sees it: the messages queued from its thread. */
export type ComposerQueue = {
  items: QueuedMessage[]
  paused: boolean
  onEdit(id: string, text: string): Promise<void>
  onRemove(id: string): Promise<void>
  onResume(): Promise<void>
}

type Props = {
  /** Which composer this is (session, and thread anchor), so its unsent draft survives switching away. */
  draftKey: string
  className: string
  placeholder: string
  /** A turn is running somewhere in the session: sending queues the message (SPEC → Queue). */
  running: boolean
  queue: ComposerQueue
  autoFocus?: boolean
  /** Focus on the app's "focus composer" shortcut. */
  primary?: boolean
  footer?: ReactNode
  /** The agent's slash commands, offered after a leading "/". */
  commands: SlashCommand[]
  /** What the agent accepts besides text. */
  accepts: { image: boolean; file: boolean }
  onSend(text: string, attachments: Attachment[]): void
  /** Offered while a turn runs in this composer's thread and the agent supports steering (SPEC → Steer). */
  onSteer?(text: string, attachments: Attachment[]): void
  onCancel(): void
}

export const FOCUS_COMPOSER = 'gloss:focus-composer'

/** Unsent text, attachments and where the caret was, by draftKey, kept while Gloss runs (SPEC → Composer). */
const drafts = new Map<string, { text: string; attachments: Attachment[]; selection?: [number, number] }>()

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
  draftKey,
  className,
  placeholder,
  running,
  autoFocus,
  primary,
  footer,
  commands,
  accepts,
  queue,
  onSend,
  onSteer,
  onCancel
}: Props): React.JSX.Element {
  const [text, setText] = useState(() => drafts.get(draftKey)?.text ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>(() => drafts.get(draftKey)?.attachments ?? [])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ref = useRef<MarkdownEditorHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // The caret goes back where it was when the user switched away (before the focus below).
  useLayoutEffect(() => {
    const el = ref.current
    const saved = drafts.get(draftKey)?.selection
    if (el && saved) el.setSelection(...saved)
    return () => {
      const draft = drafts.get(draftKey)
      if (el && draft) draft.selection = el.selection()
    }
  }, [draftKey])

  useEffect(() => {
    if (autoFocus && !running) ref.current?.focus()
  }, [autoFocus, running])

  useEffect(() => {
    if (text || attachments.length > 0) drafts.set(draftKey, { text, attachments })
    else drafts.delete(draftKey)
  }, [draftKey, text, attachments])

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

  const steer = running ? onSteer : undefined

  function submit(how: 'send' | 'steer' = 'send'): void {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    if (how === 'steer' && steer) steer(trimmed, attachments)
    else onSend(trimmed, attachments)
    setText('')
    setAttachments([])
    setError(null)
  }

  const canAttach = accepts.image || accepts.file

  /** Runs a queue action, showing its error. Resolves to whether it worked. */
  async function queueAction(action: () => Promise<void>): Promise<boolean> {
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }

  return (
    <div className={className}>
      {queue.items.length > 0 && (
        <div className="queue">
          {queue.paused && (
            <p className="queue-paused">
              Queue paused: the last turn didn&apos;t finish.
              <button onClick={() => void queueAction(queue.onResume)}>Resume</button>
            </p>
          )}
          <ol aria-label="Queued messages">
            {queue.items.map((item) => (
              <QueuedRow
                key={item.id}
                item={item}
                onEdit={(text) => queueAction(() => queue.onEdit(item.id, text))}
                onRemove={() => void queueAction(() => queue.onRemove(item.id))}
              />
            ))}
          </ol>
        </div>
      )}
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
          <MarkdownEditor
            ref={ref}
            placeholder={placeholder}
            ariaLabel={placeholder}
            value={text}
            onChange={(value) => {
              setText(value)
              setPick(0)
            }}
            onPasteFiles={(files) => {
              if (canAttach) void addFiles(files)
              else setError("The agent doesn't accept images or files.")
              return true
            }}
            onKeyDown={(e) => {
              if (matches.length === 0 || e.isComposing) return false
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                setPick((picked + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
                return true
              }
              // Enter on an exact match sends it; otherwise Enter or Tab completes.
              if ((e.key === 'Enter' && !e.shiftKey && matches[picked].name !== slash?.[1]) || e.key === 'Tab') {
                choose(matches[picked])
                return true
              }
              if (e.key === 'Escape') {
                e.stopPropagation()
                setDismissed(text)
                return true
              }
              return false
            }}
            onSubmit={submit}
          />
          {running && (
            <button className="cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
          {steer && (
            <button
              className="steer"
              onClick={() => submit('steer')}
              disabled={!text.trim() && attachments.length === 0}
              title="Send into the running turn now (Ctrl+Enter)"
            >
              Steer
            </button>
          )}
          <button
            className="primary send"
            onClick={() => submit()}
            disabled={!text.trim() && attachments.length === 0}
            title={running ? 'Sent when the running turn ends' : undefined}
          >
            {running ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      {error && <p className="composer-error">{error}</p>}
      {footer}
    </div>
  )
}

/** A queued message: its text (editable in place), attachments, Edit and Remove. */
function QueuedRow(props: { item: QueuedMessage; onEdit(text: string): Promise<boolean>; onRemove(): void }): React.JSX.Element {
  const { item } = props
  const [draft, setDraft] = useState<string | null>(null)

  async function save(): Promise<void> {
    if (draft !== null && (await props.onEdit(draft))) setDraft(null)
  }

  const files = item.attachments.length
  return (
    <li className="queued">
      {draft === null ? (
        <>
          <span className="queued-text">
            {item.text}
            {files > 0 && <span className="muted"> (+{files === 1 ? '1 attachment' : `${files} attachments`})</span>}
          </span>
          <button aria-label="Edit queued message" onClick={() => setDraft(item.text)}>
            Edit
          </button>
          <button aria-label="Remove queued message" onClick={props.onRemove}>
            Remove
          </button>
        </>
      ) : (
        <>
          <textarea
            autoFocus
            aria-label="Edit queued message"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void save()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setDraft(null)
              }
            }}
          />
          <button onClick={() => void save()}>Save</button>
          <button onClick={() => setDraft(null)}>Cancel</button>
        </>
      )}
    </li>
  )
}
