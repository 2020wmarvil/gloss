import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { normalizeShortcut, shortcutLabel } from '@shared/shortcut'
import type { ContextItem } from '@shared/composer'
import type { Attachment, QueuedMessage, SlashCommand } from '@shared/types'
import { errorText } from './errors'
import { composerMention, mentionPrefix } from './composerMention'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'
import { ArrowUp, Clock, CornerDownRight, Ellipsis, MapPin, Paperclip, Pencil, Scan, Square, Trash, X } from 'lucide-react'
import { RewindDialog } from './RewindDialog'
import { Popover } from './Popover'
import { AnnotateDialog } from './AnnotateDialog'
import { loadImage, type Annotation } from './capture/annotate'

/** The session's queue as one composer sees it: the messages queued from its thread. */
export type ComposerQueue = {
  items: QueuedMessage[]
  paused: boolean
  onEdit(id: string, text: string): Promise<void>
  onRemove(id: string): Promise<void>
  onResume(): Promise<void>
}

type Props = {
  sessionId?: string
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
  /** The main conversation's composer: focused on FOCUS_MAIN_COMPOSER. */
  main?: boolean
  footer?: ReactNode
  /** The agent's slash commands, offered after a leading "/". */
  commands: SlashCommand[]
  /** What the agent accepts besides text. */
  accepts: { image: boolean; file: boolean }
  /** Messages sent in every session, newest first: Up and Down recall them (SPEC → Composer → History). */
  history?: string[]
  onSend(text: string, attachments: Attachment[]): void
  /** Offered while a turn runs in this composer's thread and the agent supports steering (SPEC → Steer). */
  onSteer?(text: string, attachments: Attachment[]): void
  /** Given only to the active thread composer, where the Stop button is shown. */
  onCancel?(): void
  /** Escape interrupts the session, including a turn running in another thread. */
  onInterrupt?(): void
  /** A thread's composer: sends the message to the main conversation instead (SPEC → Send to main). */
  onSendToMain?(text: string, attachments: Attachment[]): void
}

export const FOCUS_COMPOSER = 'gloss:focus-composer'
export const FOCUS_MAIN_COMPOSER = 'gloss:focus-main-composer'
/** The capture shortcut was pressed: capture into the composer used last, else the primary one (SPEC → Visual feedback). */
export const CAPTURE = 'gloss:capture'

/** The capture shortcut setting, for the Capture item's tooltip; empty when off. */
export const CaptureShortcut = createContext('')

/** The captures in drafts, so Edit reopens them with their pins and marks until they are sent. */
const annotations = new WeakMap<Attachment, Annotation>()

/** The composers on screen that can take a capture, by draftKey, and the one used last. */
const captureTargets = new Map<string, { start(): void; primary: boolean }>()
let lastComposer: string | null = null
let listening = false

function listenForCapture(): void {
  if (listening) return
  listening = true
  window.addEventListener(CAPTURE, () => {
    const target = (lastComposer !== null ? captureTargets.get(lastComposer) : undefined) ?? [...captureTargets.values()].find((t) => t.primary)
    target?.start()
  })
}

/** Unsent text, attachments and where the caret was, by draftKey, kept while Gloss runs (SPEC → Composer). */
type Draft = { text: string; attachments: Attachment[]; selection?: [number, number] }
const drafts = new Map<string, Draft>()
const stashedDrafts = new Map<string, Draft>()
type EditorState = { busy: boolean; error?: string }
const editorStates = new Map<string, EditorState>()
type ShellState = { running: boolean; error?: string }
const shellStates = new Map<string, ShellState>()
const DRAFT_CHANGED = 'gloss:composer-draft'
function publishShell(key: string, state: ShellState): void {
  shellStates.set(key, state)
  window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: { key } }))
}

/** Keys that move the caret within the text, which stop cycling through the history. */
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

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
  sessionId,
  draftKey,
  className,
  placeholder,
  running,
  autoFocus,
  primary,
  main,
  footer,
  commands,
  accepts,
  queue,
  history = [],
  onSend,
  onSteer,
  onCancel,
  onInterrupt,
  onSendToMain
}: Props): React.JSX.Element {
  const [text, setText] = useState(() => drafts.get(draftKey)?.text ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>(() => drafts.get(draftKey)?.attachments ?? [])
  const [shell, setShell] = useState<ShellState>(() => shellStates.get(draftKey) ?? { running: false })
  const [rewindOpen, setRewindOpen] = useState(false)
  const [caret, setCaret] = useState(0)
  const contextMenu = useRef<HTMLUListElement>(null)
  const [contexts, setContexts] = useState<ContextItem[]>([])
  const [contextPick, setContextPick] = useState(0)
  const [contextBusy, setContextBusy] = useState(false)
  const [editor, setEditor] = useState<EditorState>(() => editorStates.get(draftKey) ?? { busy: false })
  const editorBusy = editor.busy
  const lastEscape = useRef<number | null>(null)
  const restoreSelection = useRef<[number, number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ref = useRef<MarkdownEditorHandle>(null)
  /** The history entry shown (0 = newest); null when not browsing. */
  const browsing = useRef<number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** The capture being annotated, and which attachment it replaces (Edit) or null for a new one. */
  const [annotating, setAnnotating] = useState<{ annotation: Annotation; index: number | null; attached?: boolean } | null>(null)
  const startCapture = useRef<() => void>(() => {})
  const captureKeys = normalizeShortcut(useContext(CaptureShortcut))

  useEffect(() => {
    const update = (event: Event): void => {
      const detail = (event as CustomEvent<{ key: string; focus?: boolean }>).detail
      if (detail.key !== draftKey) return
      setShell(shellStates.get(draftKey) ?? { running: false })
      setEditor(editorStates.get(draftKey) ?? { busy: false })
      const draft = drafts.get(draftKey)
      if (draft) { setText(draft.text); setAttachments(draft.attachments) }
      if (detail.focus) ref.current?.focus()
    }
    window.addEventListener(DRAFT_CHANGED, update)
    return () => window.removeEventListener(DRAFT_CHANGED, update)
  }, [draftKey])

  async function runShell(): Promise<void> {
    if (!sessionId || shell.running) return
    const command = text.trim().slice(1).trim()
    if (!command) { setError('Enter a command after !.'); return }
    setError(null)
    const draft = drafts.get(draftKey) ?? { text, attachments }
    drafts.set(draftKey, { ...draft, text: '' })
    setText('')
    publishShell(draftKey, { running: true })
    try {
      await window.gloss.composer.shell(sessionId, command)
      publishShell(draftKey, { running: false })
    } catch (err) { publishShell(draftKey, { running: false, error: errorText(err) }) }
  }

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

  // Only when shown: a turn ending elsewhere mustn't pull the caret here.
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

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

  useEffect(() => {
    if (!main) return
    const focus = (): void => ref.current?.focus()
    window.addEventListener(FOCUS_MAIN_COMPOSER, focus)
    return () => window.removeEventListener(FOCUS_MAIN_COMPOSER, focus)
  }, [main])

  /** Captures the screen and opens the annotation canvas on it (SPEC → Visual feedback). */
  async function capture(): Promise<void> {
    if (annotating) return
    if (!accepts.image) {
      setError("The agent doesn't accept images.")
      return
    }
    setError(null)
    try {
      const c = await window.gloss.capture.start()
      if (c) setAnnotating({ annotation: { capture: c, shapes: [], pins: [] }, index: null })
    } catch (err) {
      setError(errorText(err))
    }
  }
  startCapture.current = () => void capture()

  /** Opens the annotation canvas on an attached image; adding replaces it with the annotated one. */
  async function annotateImage(image: Extract<Attachment, { kind: 'image' }>, index: number): Promise<void> {
    if (annotating) return
    try {
      const capture = { data: image.data, mimeType: image.mimeType, width: 0, height: 0, source: image.name }
      const img = await loadImage(capture)
      setAnnotating({ annotation: { capture: { ...capture, width: img.naturalWidth, height: img.naturalHeight }, shapes: [], pins: [] }, index, attached: true })
    } catch (err) {
      setError(errorText(err))
    }
  }

  useEffect(() => {
    listenForCapture()
    captureTargets.set(draftKey, { start: () => startCapture.current(), primary: Boolean(primary) })
    return () => {
      captureTargets.delete(draftKey)
    }
  }, [draftKey, primary])

  // Slash commands: offered while the text is a single "/word" at the start.
  const localCommands: SlashCommand[] = [
    { name: 'stash', description: 'Stash or swap the current draft' },
    { name: 'editor', description: 'Edit the prompt in your external editor' },
    ...(sessionId ? [{ name: 'rewind', description: 'Remove a message and later conversation history' }] : [])
  ].filter((c) => !commands.some((agent) => agent.name === c.name))
  const availableCommands = [...commands, ...localCommands]
  const slash = /^\/(\S*)$/.exec(text)
  const matches =
    slash && dismissed !== text
      ? availableCommands.filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase())).slice(0, 8)
      : []
  const picked = matches.length > 0 ? Math.min(pick, matches.length - 1) : 0

  const mention = composerMention(text, caret)
  const mentionQuery = mention?.query
  const contextPicked = Math.min(contextPick, Math.max(0, contexts.length - 1))
  useEffect(() => {
    setContexts([])
    if (mentionQuery === undefined || !sessionId || dismissed === text || !(accepts.file || accepts.image)) return
    let active = true
    const timer = setTimeout(() => {
      void window.gloss.composer.contexts(sessionId, mentionQuery).then(
        (items) => { if (active) { setContexts(items); setContextPick(0) } },
        (err: unknown) => { if (active) setError(errorText(err)) }
      )
    }, 120)
    return () => { active = false; clearTimeout(timer) }
  }, [mentionQuery, sessionId, dismissed, text, accepts.file, accepts.image])

  useEffect(() => {
    contextMenu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [contextPicked, contexts])

  async function chooseContext(item: ContextItem): Promise<void> {
    if (!sessionId || contextBusy || !mention) return
    if (item.browse) {
      const path = item.label.startsWith('~/') ? item.label : `${item.id.replace(/[\\/]$/, '')}/`
      const inserted = mentionPrefix(path)
      const value = text.slice(0, mention.start) + inserted + text.slice(mention.end)
      restoreSelection.current = [mention.start + inserted.length, mention.start + inserted.length]
      setText(value)
      setCaret(mention.start + inserted.length)
      setContexts([])
      ref.current?.focus()
      return
    }
    if (attachments.length >= 20) { setError('A message can have up to 20 attachments.'); return }
    const before = text
    const start = mention.start
    setContextBusy(true)
    setError(null)
    try {
      const attachment = await window.gloss.composer.attach(sessionId, item)
      if (attachment.kind === 'image' ? !accepts.image : !accepts.file) throw new Error(`This agent doesn't accept ${attachment.kind === 'image' ? 'images' : 'attached files'}.`)
      setAttachments((list) => [...list, attachment])
      setText((value) => value === before && start >= 0 ? value.slice(0, start) + value.slice(caret) : value)
      setContexts([])
      ref.current?.focus()
    } catch (err) { setError(errorText(err)) }
    finally { setContextBusy(false) }
  }

  async function editExternally(value = text): Promise<void> {
    if (editorStates.get(draftKey)?.busy) return
    setError(null)
    editorStates.set(draftKey, { busy: true })
    window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: { key: draftKey } }))
    try {
      const edited = await window.gloss.composer.editDraft(value)
      const draft = drafts.get(draftKey) ?? { text: value, attachments: [] }
      if (draft.text !== edited) stashedDrafts.set(draftKey, draft)
      drafts.set(draftKey, { ...draft, text: edited, selection: [edited.length, edited.length] })
      editorStates.set(draftKey, { busy: false })
    } catch (err) {
      editorStates.set(draftKey, { busy: false, error: errorText(err) })
    } finally {
      window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, { detail: { key: draftKey, focus: true } }))
    }
  }

  function escape(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return false
    if (e.repeat) return true
    e.stopPropagation()
    const now = Date.now()
    if (sessionId && lastEscape.current !== null && now >= lastEscape.current && now - lastEscape.current <= 400) {
      lastEscape.current = null
      setRewindOpen(true)
      return true
    }
    lastEscape.current = now
    if (shell.running && sessionId) {
      void window.gloss.composer.cancelShell(sessionId).catch((err: unknown) => setError(errorText(err)))
    } else if (running && (onInterrupt || onCancel)) {
      (onInterrupt ?? onCancel)?.()
    }
    return !!sessionId || (running && !!(onInterrupt || onCancel))
  }

  // Escape also works while reading the log. Menus and dialogs handle it first.
  const latestEscape = useRef(escape)
  latestEscape.current = escape
  useEffect(() => {
    if (!primary) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || document.querySelector('[role="dialog"], .popover')) return
      if (e.key !== 'Escape') { lastEscape.current = null; return }
      if (latestEscape.current(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [primary])

  function runLocalCommand(name: string): boolean {
    if (!localCommands.some((c) => c.name === name)) return false
    if (name === 'stash') stashDraft('')
    if (name === 'editor') { void editExternally(''); setText('') }
    if (name === 'rewind') { setText(''); setRewindOpen(true) }
    return true
  }

  function choose(c: SlashCommand): void {
    if (runLocalCommand(c.name)) return
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
  /** What Send does now: send, steer the running turn, or queue for after it (SPEC → Queue and Steer). */
  const mode: 'send' | 'steer' | 'queue' = steer ? 'steer' : running ? 'queue' : 'send'
  const commandMode = text.trimStart().startsWith('!')
  const empty = !text.trim() && attachments.length === 0

  /**
   * Up in an empty composer starts cycling through the history: from then on Up shows the
   * previous entry and Down the next, whatever line the caret is on (the editor puts it
   * at the end of each), and Down past the newest empties the composer again. Editing or
   * moving the caret stops cycling (see `leave`). Returns whether it took the key.
   */
  function recall(dir: 1 | -1): boolean {
    const current = browsing.current
    // Once something is typed (or a recalled message is being worked on), the arrows are the editor's.
    if (current === null && (dir === -1 || text !== '')) return false
    const index = (current ?? -1) + dir
    // At the oldest entry, Up stays put rather than moving the caret.
    if (index >= history.length) return current !== null
    const value = index < 0 ? '' : history[index]
    browsing.current = index < 0 ? null : index
    // A recalled "/command" shouldn't open the slash menu, which would take the arrows.
    setDismissed(value)
    setText(value)
    return true
  }

  /** Stops cycling on the recalled message shown, which the user is now working on. */
  function leave(): void {
    browsing.current = null
  }

  function submit(how: 'send' | 'steer' | 'main' = 'send'): void {
    if (contextBusy || editorBusy) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    if (trimmed.startsWith('!')) { void runShell(); return }
    if (attachments.length === 0 && /^\/[^\s]+$/.test(trimmed) && runLocalCommand(trimmed.slice(1))) return
    if (how !== 'main' && steer) steer(trimmed, attachments)
    else if (how === 'main' && onSendToMain) onSendToMain(trimmed, attachments)
    else onSend(trimmed, attachments)
    browsing.current = null
    setText('')
    setAttachments([])
    setError(null)
  }

  function stashDraft(value = text): void {
    const saved = stashedDrafts.get(draftKey)
    const current = { text: value, attachments, selection: ref.current?.selection() }
    if (value || attachments.length) stashedDrafts.set(draftKey, current)
    else stashedDrafts.delete(draftKey)
    setText(saved?.text ?? '')
    setAttachments(saved?.attachments ?? [])
    restoreSelection.current = saved?.selection ?? [0, 0]
    leave()
    ref.current?.focus()
  }

  useEffect(() => {
    if (restoreSelection.current) {
      ref.current?.setSelection(...restoreSelection.current)
      restoreSelection.current = null
    }
  }, [text, attachments])

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
    <div className={`${className}${commandMode ? ' command-mode' : ''}`} onFocus={() => (lastComposer = draftKey)}>
      {queue.items.length > 0 && (
        <div className="queue">
          {queue.paused && (
            <p className="queue-paused">
              Queue paused: the last turn didn&apos;t finish.
              <button onClick={() => void queueAction(queue.onResume)}>Resume</button>
            </p>
          )}
          {/* The next to run at the bottom, by the composer (as in the Queue tab). */}
          <ol aria-label="Queued messages">
            {[...queue.items].reverse().map((item) => (
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
      {contexts.length > 0 && (
        <ul ref={contextMenu} className="slash-menu" role="listbox" aria-label="Attach context">
          {contexts.map((item, i) => <li key={`${item.kind}:${item.id}`} role="option" aria-selected={i === contextPicked} onMouseMove={() => setContextPick(i)}>
            <button type="button" className={i === contextPicked ? 'on' : undefined} onMouseDown={(e) => e.preventDefault()} disabled={contextBusy} onClick={() => void chooseContext(item)}>
              <span className="slash-name">{item.label}</span><span className="slash-desc">{item.description}</span>
            </button>
          </li>)}
        </ul>
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
            {attachments.map((a, i) =>
              a.kind === 'image' ? (
                <CaptureChip
                  key={i}
                  image={a}
                  onEdit={
                    annotations.has(a)
                      ? () => setAnnotating({ annotation: annotations.get(a)!, index: i })
                      : // Pins already drawn in (a recalled message) would clash with new ones.
                        a.pins
                        ? undefined
                        : () => void annotateImage(a, i)
                  }
                  onRemove={() => setAttachments((list) => list.filter((_, j) => j !== i))}
                />
              ) : (
              <li key={i} className="attachment" title={a.path ?? a.name}>
                <span className="attachment-name">{a.name}</span>
                <button
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
                >
                  <X size={14} />
                </button>
              </li>
              )
            )}
          </ul>
        )}
        <div className="box-row">
          {canAttach && (
            <>
              {/* One button for everything a message can carry: files, and a screen capture. */}
              <Popover className="attach" title="Attach" label={<Paperclip aria-label="Attach" />}>
                {(close) => (
                  <div className="menu-list attach-menu">
                    <button onClick={() => (close(), fileInput.current?.click())}>
                      <span className="menu-row">
                        <Paperclip size={14} />
                        Attachments
                      </span>
                    </button>
                    <button
                      disabled={!accepts.image}
                      title={accepts.image && captureKeys ? `Screen capture (${shortcutLabel(captureKeys, /Mac/.test(navigator.userAgent))})` : undefined}
                      onClick={() => (close(), void capture())}
                    >
                      <span className="menu-row">
                        <Scan size={14} />
                        Screen capture
                      </span>
                      {!accepts.image && <span className="muted">This agent doesn&apos;t accept images.</span>}
                    </button>
                  </div>
                )}
              </Popover>
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
            plainText={commandMode}
            onChange={(value) => {
              // Editing a recalled message makes it the draft.
              const shown = browsing.current
              if (shown !== null && value !== history[shown]) leave()
              setText(value)
              setCaret(ref.current?.selection()[1] ?? value.length)
              setPick(0)
            }}
            onSelectionChange={() => { leave(); setCaret(ref.current?.selection()[1] ?? 0) }}
            onPasteFiles={(files) => {
              if (canAttach) void addFiles(files)
              else setError("The agent doesn't accept images or files.")
              return true
            }}
            onKeyDown={(e) => {
              if (e.isComposing) return false
              if (e.key === 'Escape' && document.querySelector('[role="dialog"], .popover')) return false
              if (e.key !== 'Escape') lastEscape.current = null
              if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
                if (e.key.toLowerCase() === 's') { stashDraft(); return true }
                if (e.key.toLowerCase() === 'g') { void editExternally(); return true }
              }
              if (contexts.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { setContextPick((contextPicked + (e.key === 'ArrowDown' ? 1 : contexts.length - 1)) % contexts.length); return true }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { void chooseContext(contexts[contextPicked]); return true }
                if (e.key === 'Escape') { lastEscape.current = null; e.stopPropagation(); setContexts([]); setDismissed(text); return true }
              }
              if (matches.length === 0) {
                const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
                if (plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return recall(e.key === 'ArrowUp' ? 1 : -1)
                // Even where the caret can't go further (Right at the end), these mean "edit this one".
                if (CARET_KEYS.has(e.key)) leave()
                return escape(e)
              }
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
                lastEscape.current = null
                e.stopPropagation()
                setDismissed(text)
                return true
              }
              return false
            }}
            onSubmit={submit}
          />
          {running && onCancel && (
            <button className="cancel" onClick={onCancel} title="Stop the running turn (Esc)">
              <Square />
              Stop
            </button>
          )}
          {onSendToMain && (
            <Popover className="icon-button composer-more" title="More ways to send" label={<Ellipsis />} disabled={empty || contextBusy || editorBusy || (commandMode && shell.running)}>
              {(close) => (
                <div className="menu-list">
                  <button
                    className="to-main"
                    onClick={() => (close(), submit('main'))}
                    title={running ? 'Steers the main conversation if it is active, otherwise queues' : undefined}
                  >
                    Send to main
                    <span className="muted">Continue in the main conversation instead of this thread</span>
                  </button>
                </div>
              )}
            </Popover>
          )}
          <button
            className={mode === 'queue' ? 'secondary send' : 'primary send'}
            onClick={() => submit()}
            disabled={empty || contextBusy || editorBusy || (commandMode && shell.running)}
            title={mode === 'steer' ? 'Send into the running turn now' : mode === 'queue' ? 'Sent when the running turn ends' : undefined}
          >
            {mode === 'steer' ? <CornerDownRight /> : mode === 'queue' ? <Clock /> : <ArrowUp />}
            {commandMode ? 'Run command' : mode === 'steer' ? 'Steer' : mode === 'queue' ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      {shell.running && <div className="shell-status" role="status">
        <span>Running shell command. Esc to stop.</span>
      </div>}
      {shell.error && <p className="composer-error" role="alert">{shell.error}</p>}
      {rewindOpen && sessionId && <RewindDialog sessionId={sessionId} onClose={() => { setRewindOpen(false); ref.current?.focus() }} />}
      {editorBusy && <p className="editor-status" role="status">Editing in external editor. Save and close the file to return.</p>}
      {editor.error && <p className="composer-error" role="alert">{editor.error}</p>}
      {error && <p className="composer-error">{error}</p>}
      {footer}
      {annotating && (
        <AnnotateDialog
          initial={annotating.annotation}
          onRetake={annotating.attached ? undefined : () => window.gloss.capture.start()}
          onCancel={() => {
            setAnnotating(null)
            ref.current?.focus()
          }}
          onAdd={(image, annotation) => {
            annotations.set(image, annotation)
            const index = annotating.index
            setAttachments((list) => (index === null ? [...list, image] : list.map((a, i) => (i === index ? image : a))))
            setAnnotating(null)
            ref.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/** An image in the composer (an annotated capture: the flattened image and its pin count), Edit and Remove. */
function CaptureChip(props: {
  image: Extract<Attachment, { kind: 'image' }>
  onEdit?(): void
  onRemove(): void
}): React.JSX.Element {
  const { image } = props
  const pins = image.pins?.length ?? 0
  return (
    <li className="attachment capture" title={`${image.name}${pins ? ` · ${pins} pin${pins === 1 ? '' : 's'}` : ''}`}>
      <img src={`data:${image.mimeType};base64,${image.data}`} alt={pins ? `Screenshot with ${pins} pins` : image.name} />
      {pins > 0 && (
        <span className="pin-pill">
          <MapPin size={11} />
          {pins}
        </span>
      )}
      {props.onEdit && (
        <button className="capture-edit" aria-label="Edit the annotations" onClick={props.onEdit}>
          <span>
            <Pencil size={14} />
            Edit
          </span>
        </button>
      )}
      <button className="attachment-remove" aria-label={`Remove ${image.name}`} onClick={props.onRemove}>
        <X size={14} />
      </button>
    </li>
  )
}

/** A queued message: its text (editable in place), attachments, Edit and Remove. */
export function QueuedRow(props: {
  item: QueuedMessage
  onEdit(text: string): Promise<boolean>
  onRemove(): void
  /** Above the text, e.g. the thread it runs in (the Queue tab). */
  label?: ReactNode
  /** Clicking the row outside its buttons. */
  onOpen?(): void
}): React.JSX.Element {
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
          <span
            className={props.onOpen ? 'queued-text link' : 'queued-text'}
            role={props.onOpen ? 'button' : undefined}
            tabIndex={props.onOpen ? 0 : undefined}
            onClick={props.onOpen}
            onKeyDown={(e) => {
              if (props.onOpen && e.key === 'Enter') props.onOpen()
            }}
          >
            {props.label ?? (
              <span className="queued-state">
                <span className="state-dot" data-state="queued" aria-hidden />
                Queued
              </span>
            )}
            {item.text}
            {files > 0 && <span className="muted"> (+{files === 1 ? '1 attachment' : `${files} attachments`})</span>}
          </span>
          <button className="queued-icon" aria-label="Edit queued message" title="Edit" onClick={() => setDraft(item.text)}>
            <Pencil size={14} />
          </button>
          <button className="queued-icon" aria-label="Remove queued message" title="Remove" onClick={props.onRemove}>
            <Trash size={14} />
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
