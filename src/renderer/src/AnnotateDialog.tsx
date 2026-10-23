// The annotation canvas (SPEC → Visual feedback, docs/mocks/visual-feedback.html#annotate):
// numbered pins with a note each, and pen, highlighter, box and arrow marks over a capture.
// The right column shows exactly the text that goes with the image.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Crop, Eye, Highlighter, MapPin, MoveUpRight, PanelRight, Pencil, Redo2, Square, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { ResizeHandle, useStoredWidth } from './resize'
import type { Capture } from '@shared/capture'
import type { Attachment, Pin } from '@shared/types'
import { pinList } from '@shared/wire'
import {
  flatten,
  isTiny,
  loadImage,
  MARK_COLORS,
  paint,
  pinAt,
  pinRadius,
  type Annotation,
  type Shape,
  type Tool
} from './capture/annotate'
import { errorText } from './errors'

type Props = {
  initial: Annotation
  /** Adds the flattened image to the composer; `annotation` reopens it with Edit. */
  onAdd(image: Extract<Attachment, { kind: 'image' }>, annotation: Annotation): void
  onCancel(): void
  /** Opens the region overlay again; null if the user cancelled there. */
  onRetake(): Promise<Capture | null>
}

const TOOLS: { tool: Tool; key: string; name: string; icon: React.JSX.Element }[] = [
  { tool: 'pin', key: 'n', name: 'Pin', icon: <MapPin /> },
  { tool: 'pen', key: 'f', name: 'Pen', icon: <Pencil /> },
  { tool: 'highlighter', key: 'h', name: 'Highlighter', icon: <Highlighter /> },
  { tool: 'box', key: 'r', name: 'Box', icon: <Square /> },
  { tool: 'arrow', key: 'a', name: 'Arrow', icon: <MoveUpRight /> }
]

type Marks = { shapes: Shape[]; pins: Pin[] }

const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
/** One step of the − and + buttons. */
const ZOOM_STEP = 1.25
/** Space around the capture inside the stage. */
const STAGE_PAD = 20
/** The pins panel's width when dragged; its default is the stylesheet's. */
const PINS_LIMITS = { min: 220, max: 560 }
const PINS_SHOWN_KEY = 'gloss:annotatePinsShown'

/** The tool and color picked last, kept for the next capture while Gloss runs. */
let lastTool: Tool = 'pin'
let lastColor = MARK_COLORS[0]

export function AnnotateDialog({ initial, onAdd, onCancel, onRetake }: Props): React.JSX.Element {
  const [capture, setCapture] = useState(initial.capture)
  const [marks, setMarks] = useState<Marks>({ shapes: initial.shapes, pins: initial.pins })
  const [past, setPast] = useState<Marks[]>([])
  const [future, setFuture] = useState<Marks[]>([])
  const [tool, setTool] = useState<Tool>(lastTool)
  const [color, setColor] = useState(lastColor)
  const [lit, setLit] = useState(-1)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  /**
   * The view: the zoom, and where the capture's top left sits in the stage. Fitted and centered
   * when a capture opens, then only what the user does: panning isn't held at the edges.
   */
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const scale = view.scale
  /** A pan in progress (right button anywhere, or left on the background). */
  const [panning, setPanning] = useState(false)
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The pins panel: collapsible and resizable, remembered like the app's other panes. */
  const [pinsWidth, setPinsWidth] = useStoredWidth('gloss:annotatePinsWidth')
  const [pinsShown, setPinsShownState] = useState(() => localStorage.getItem(PINS_SHOWN_KEY) !== 'false')
  const setPinsShown = (on: boolean): void => {
    setPinsShownState(on)
    localStorage.setItem(PINS_SHOWN_KEY, String(on))
  }
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const notes = useRef<HTMLDivElement>(null)
  /** The mark being drawn, or the pin being dragged (with the marks before, for undo). */
  const live = useRef<Shape | null>(null)
  const dragging = useRef<{ index: number; before: Marks; dx: number; dy: number } | null>(null)
  /** A pin just placed: its note takes the caret once it renders. */
  const focusNote = useRef(-1)
  const { width, height } = capture
  const r = pinRadius(width, height)

  useEffect(() => {
    lastTool = tool
    lastColor = color
  }, [tool, color])

  useEffect(() => {
    let current = true
    loadImage(capture).then(
      (img) => current && setImage(img),
      (err: unknown) => current && setError(errorText(err))
    )
    return () => {
      current = false
    }
  }, [capture])

  /** The zoom that fits the capture in the stage as it is now, never enlarged. */
  function fitScale(): number {
    const el = stage.current
    if (!el) return 1
    return Math.max(MIN_ZOOM, Math.min(1, (el.clientWidth - 2 * STAGE_PAD) / width, (el.clientHeight - 2 * STAGE_PAD) / height))
  }

  /** Fits the capture in the stage, centered. */
  function fitView(): void {
    const el = stage.current
    const k = fitScale()
    setView({ scale: k, x: el ? (el.clientWidth - width * k) / 2 : 0, y: el ? (el.clientHeight - height * k) / 2 : 0 })
  }

  // A capture opens fitted to the stage. Resizing the window later keeps the view the user has.
  useLayoutEffect(fitView, [width, height])

  /** Zooms to `next`, keeping the point under (cx, cy) in place: the cursor, or the stage's center. */
  function zoomTo(next: number, cx?: number, cy?: number): void {
    const el = stage.current
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
    if (!el) return setView((v) => ({ ...v, scale: k }))
    const box = el.getBoundingClientRect()
    const px = (cx ?? box.left + box.width / 2) - box.left
    const py = (cy ?? box.top + box.height / 2) - box.top
    setView((v) => ({ scale: k, x: px - ((px - v.x) / v.scale) * k, y: py - ((py - v.y) / v.scale) * k }))
  }

  /** Between fit and actual size: the zoom button, and 0 and 1. */
  const fitted = (): boolean => Math.abs(scale - fitScale()) < 0.005

  // The wheel zooms at the cursor. Not passive, so the page doesn't scroll too.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      zoomTo(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  /** A right-button drag anywhere pans, and so does a left-button drag on the background around the capture. */
  function onStagePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const onBackground = e.target === e.currentTarget
    if (e.button !== 2 && !(e.button === 0 && onBackground)) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    pan.current = { x: e.clientX, y: e.clientY, left: view.x, top: view.y }
    setPanning(true)
  }

  function onStagePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const p = pan.current
    if (!p) return
    e.stopPropagation()
    setView((v) => ({ ...v, x: p.left + (e.clientX - p.x), y: p.top + (e.clientY - p.y) }))
  }

  function onStagePointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (!pan.current) return
    e.stopPropagation()
    pan.current = null
    setPanning(false)
  }

  function redraw(): void {
    const ctx = canvas.current?.getContext('2d')
    if (ctx && image) paint(ctx, image, { width, height, ...marks }, live.current ?? undefined, lit)
  }
  useEffect(redraw)

  useEffect(() => {
    root.current?.focus()
  }, [])

  useEffect(() => {
    if (focusNote.current < 0) return
    notes.current?.querySelectorAll('textarea')[focusNote.current]?.focus()
    focusNote.current = -1
  })

  /** Records the marks as they were, for undo, and applies a change. */
  function change(next: Marks, before: Marks = marks): void {
    setPast((p) => [...p, before])
    setFuture([])
    setMarks(next)
  }

  function undo(): void {
    if (past.length === 0) return
    setFuture((f) => [marks, ...f])
    setMarks(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }

  function redo(): void {
    if (future.length === 0) return
    setPast((p) => [...p, marks])
    setMarks(future[0])
    setFuture((f) => f.slice(1))
  }

  function point(e: React.PointerEvent): [number, number] {
    const box = canvas.current!.getBoundingClientRect()
    return [(e.clientX - box.left) / scale, (e.clientY - box.top) / scale]
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = point(e)
    if (tool === 'pin') {
      const i = pinAt(marks.pins, x, y, r)
      if (i >= 0) {
        dragging.current = { index: i, before: marks, dx: marks.pins[i].x - x, dy: marks.pins[i].y - y }
        return
      }
      focusNote.current = marks.pins.length
      change({ ...marks, pins: [...marks.pins, { x, y, note: '' }] })
      return
    }
    live.current =
      tool === 'pen' || tool === 'highlighter'
        ? { type: tool, color, points: [[x, y]] }
        : { type: tool, color, x1: x, y1: y, x2: x, y2: y }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const [x, y] = point(e)
    const drag = dragging.current
    if (drag) {
      const pins = marks.pins.map((p, i) => (i === drag.index ? { ...p, x: clamp(x + drag.dx, width), y: clamp(y + drag.dy, height) } : p))
      setMarks({ ...marks, pins })
      return
    }
    const s = live.current
    if (!s) return
    if ('points' in s) s.points.push([x, y])
    else {
      s.x2 = x
      s.y2 = y
    }
    redraw()
  }

  function onPointerUp(): void {
    const drag = dragging.current
    if (drag) {
      dragging.current = null
      if (drag.before.pins[drag.index] !== marks.pins[drag.index]) change(marks, drag.before)
      return
    }
    const s = live.current
    live.current = null
    if (s && !isTiny(s)) change({ ...marks, shapes: [...marks.shapes, s] })
    else redraw()
  }

  function setNote(i: number, note: string): void {
    // Typing isn't an undo step; the pin it belongs to is.
    setMarks({ ...marks, pins: marks.pins.map((p, j) => (j === i ? { ...p, note } : p)) })
  }

  function removePin(i: number): void {
    setLit(-1)
    change({ ...marks, pins: marks.pins.filter((_, j) => j !== i) })
  }

  async function add(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const annotation = { capture, ...marks }
      onAdd(await flatten(annotation), annotation)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  async function retake(): Promise<void> {
    setError(null)
    try {
      const next = await onRetake()
      if (!next) return
      setImage(null)
      setCapture(next)
      setMarks({ shapes: [], pins: [] })
      setPast([])
      setFuture([])
    } catch (err) {
      setError(errorText(err))
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    // The dialog is modal: the app's shortcuts wait until it closes.
    e.stopPropagation()
    const mod = e.ctrlKey || e.metaKey
    const typing = e.target instanceof HTMLTextAreaElement
    const key = e.key.toLowerCase()
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      void add()
    } else if (mod && !typing && (key === 'z' || key === 'y')) {
      e.preventDefault()
      if (key === 'y' || e.shiftKey) redo()
      else undo()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (typing) root.current?.focus()
      else onCancel()
    } else if (!typing && !mod && !e.altKey) {
      if (e.key === '0') fitView()
      else if (e.key === '1') zoomTo(1)
      else {
        const t = TOOLS.find((x) => x.key === key)
        if (t) setTool(t.tool)
      }
    }
  }


  const text = pinList([{ kind: 'image', name: '', mimeType: '', data: '', pins: marks.pins }]) || 'Just the screenshot, without pins.'

  return createPortal(
    <div className="dialog-backdrop">
      <div
        ref={root}
        className="annotate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="annotate-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="annotate-head">
          <h2 id="annotate-title">Annotate</h2>
          <span className="muted">
            {capture.source} · {width} × {height}
          </span>
          <span className="grow" />
          <div className="annotate-tools" role="toolbar" aria-label="Tools">
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                className={tool === t.tool ? 'on' : undefined}
                aria-pressed={tool === t.tool}
                title={`${t.name} (${t.key.toUpperCase()})`}
                aria-label={t.name}
                onClick={() => setTool(t.tool)}
              >
                {t.icon}
              </button>
            ))}
            <span className="annotate-sep" />
            {MARK_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${color === c ? ' on' : ''}`}
                aria-pressed={color === c}
                title="Color for marks"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
              >
                <i style={{ background: c }} />
              </button>
            ))}
            <span className="annotate-sep" />
            <button title="Undo (Ctrl+Z)" aria-label="Undo" disabled={past.length === 0} onClick={undo}>
              <Undo2 />
            </button>
            <button title="Redo (Ctrl+Y)" aria-label="Redo" disabled={future.length === 0} onClick={redo}>
              <Redo2 />
            </button>
            <span className="annotate-sep" />
            <button title="Zoom out" aria-label="Zoom out" disabled={scale <= MIN_ZOOM} onClick={() => zoomTo(scale / ZOOM_STEP)}>
              <ZoomOut />
            </button>
            <button
              className="annotate-zoom"
              title={fitted() ? 'Actual size (1)' : 'Fit (0)'}
              aria-label={fitted() ? 'Zoom to actual size' : 'Zoom to fit'}
              onClick={() => (fitted() ? zoomTo(1) : fitView())}
            >
              {`${Math.round(scale * 100)}%`}
            </button>
            <button title="Zoom in" aria-label="Zoom in" disabled={scale >= MAX_ZOOM} onClick={() => zoomTo(scale * ZOOM_STEP)}>
              <ZoomIn />
            </button>
          </div>
          <span className="grow" />
          <button className="ghost sm" onClick={() => void retake()}>
            <Crop size={14} />
            Retake
          </button>
          <button
            className="icon-button"
            title={pinsShown ? 'Hide pins' : 'Show pins'}
            aria-label={pinsShown ? 'Hide pins' : 'Show pins'}
            aria-pressed={pinsShown}
            onClick={() => setPinsShown(!pinsShown)}
          >
            <PanelRight />
          </button>
          <button className="icon-button" title="Cancel (Esc)" aria-label="Cancel" onClick={onCancel}>
            <X />
          </button>
        </header>
        <div className="annotate-body">
        <div
          ref={stage}
          className={`annotate-stage${panning ? ' panning' : ''}`}
          onPointerDownCapture={onStagePointerDown}
          onPointerMoveCapture={onStagePointerMove}
          onPointerUpCapture={onStagePointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <canvas
            ref={canvas}
            className={[tool === 'pin' && 'pin-tool', scale >= 2 && 'pixels'].filter(Boolean).join(' ') || undefined}
            width={width}
            height={height}
            style={{ left: view.x, top: view.y, width: width * scale, height: height * scale }}
            aria-label="The capture: click to place a pin, or drag to draw"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
        {pinsShown && (
          <ResizeHandle
            label="Resize the pins panel"
            pane="after"
            limits={PINS_LIMITS}
            value={pinsWidth}
            onResize={setPinsWidth}
            onReset={() => setPinsWidth(null)}
          />
        )}
        {pinsShown && (
        <aside className="annotate-pins" style={pinsWidth === null ? undefined : { flexBasis: pinsWidth }}>
          <div className="annotate-pins-head">
            Pins <span className="count">{marks.pins.length}</span>
          </div>
          <div ref={notes} className="annotate-pin-list">
            {marks.pins.length === 0 ? (
              <p className="annotate-empty">
                Choose <b>Pin</b> (<kbd>N</kbd>) and click the image. Each pin gets a number and a note, and the agent can refer to it
                by number.
              </p>
            ) : (
              marks.pins.map((p, i) => (
                <div
                  key={i}
                  className={`annotate-pin${lit === i ? ' lit' : ''}`}
                  onMouseEnter={() => setLit(i)}
                  onMouseLeave={() => setLit(-1)}
                >
                  <span className="pin-number">{i + 1}</span>
                  <textarea
                    rows={1}
                    placeholder="What about it?"
                    aria-label={`Note for pin ${i + 1}`}
                    value={p.note}
                    onChange={(e) => setNote(i, e.target.value)}
                  />
                  <button className="icon-button" title="Delete pin" aria-label={`Delete pin ${i + 1}`} onClick={() => removePin(i)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="annotate-text">
            <div className="annotate-text-head">Sent with the image</div>
            <pre>{text}</pre>
          </div>
        </aside>
        )}
        </div>
        <footer className="annotate-foot">
          <span className="muted annotate-note">
            <Eye size={14} />
            The agent gets this image and the text beside it, nothing else.
          </span>
          {error && <span className="dialog-error">{error}</span>}
          <span className="grow" />
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !image} onClick={() => void add()}>
            Add to message <kbd>Ctrl</kbd>
            <kbd>Enter</kbd>
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(max, v))
}
