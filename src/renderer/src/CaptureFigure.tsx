// An annotated screenshot in a sent message (SPEC → Visual feedback): its pins are anchors.
// Clicking a pin, or its note below the image, opens that pin's thread; pins with a thread
// carry its reply count. Clicking the image enlarges it, pins still clickable.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquare, X } from 'lucide-react'
import type { Attachment, Message } from '@shared/types'
import type { OpenSession, Panel } from './App'
import { pinRadius } from './capture/annotate'

/** What a log needs to make pins anchors; without it pins only show. */
export type PinAnchors = {
  /** The pin's thread, if it has one. */
  threadOf(messageId: string, image: number, pin: number): { id: string; replies: number } | undefined
  /** The pin whose thread the side panel shows. */
  active: { messageId: string; image: number; pin: number } | null
  /** The thread a turn runs in. */
  runningThread: string | null
  onOpenPin(message: Message, image: number, pin: number): void
}

/** Pin anchors for a session's logs: its pin threads, their reply counts, and the pin the panel shows. */
export function pinAnchorsFor(
  open: OpenSession,
  panel: Panel | null,
  runningThread: string | null | undefined,
  onOpenPin: PinAnchors['onOpenPin']
): PinAnchors {
  const replies = new Map<string, number>()
  for (const m of open.messages) if (m.threadId !== null) replies.set(m.threadId, (replies.get(m.threadId) ?? 0) + 1)
  const a = panel?.anchor
  return {
    threadOf: (messageId, image, pin) => {
      const t = open.threads.find((t) => t.anchorMessageId === messageId && t.anchor.kind === 'pin' && t.anchor.image === image && t.anchor.pin === pin)
      return t && { id: t.id, replies: replies.get(t.id) ?? 0 }
    },
    active: panel?.anchorMessageId && a?.kind === 'pin' ? { messageId: panel.anchorMessageId, image: a.image, pin: a.pin } : null,
    runningThread: runningThread ?? null,
    onOpenPin
  }
}

type Image = Extract<Attachment, { kind: 'image' }>

type Props = {
  message: Message
  image: Image
  index: number
  anchors?: PinAnchors
}

/** Pins over the image, positioned in percent so they follow its size. */
function PinTargets({ message, image, index, anchors, width, height }: Props & { width: number; height: number }): React.JSX.Element {
  const pins = image.pins ?? []
  // A little larger than the pin drawn on the image.
  const size = (pinRadius(width, height) * 2 + 6) / width
  return (
    <>
      {pins.map((p, i) => {
        const n = i + 1
        const thread = anchors?.threadOf(message.id, index, n)
        const active = anchors?.active?.messageId === message.id && anchors.active.image === index && anchors.active.pin === n
        const running = thread !== undefined && anchors?.runningThread === thread.id
        const classes = ['pin-target', active && 'active', running && 'running'].filter(Boolean).join(' ')
        return (
          <button
            key={i}
            className={classes}
            data-thread={thread?.id}
            style={{ left: `${(p.x / width) * 100}%`, top: `${(p.y / height) * 100}%`, width: `${size * 100}%` }}
            title={p.note ? `Pin ${n}: ${p.note}` : `Pin ${n}`}
            aria-label={`Reply to pin ${n}`}
            disabled={!anchors}
            onClick={(e) => {
              e.stopPropagation()
              anchors?.onOpenPin(message, index, n)
            }}
          >
            {thread && (thread.replies > 0 || running) && (
              <span className="anchor-chip">
                {running ? <span className="running-dot" aria-label="Running" /> : <MessageSquare size={12} />}
                {thread.replies}
              </span>
            )}
          </button>
        )
      })}
    </>
  )
}

export function CaptureFigure(props: Props): React.JSX.Element {
  const { message, image, index, anchors } = props
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [enlarged, setEnlarged] = useState(false)
  const src = `data:${image.mimeType};base64,${image.data}`
  const pins = image.pins ?? []

  useEffect(() => {
    if (!enlarged) return
    const close = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setEnlarged(false)
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [enlarged])

  const open = (i: number, n: number): void => {
    setEnlarged(false)
    anchors?.onOpenPin(message, i, n)
  }
  const targets = size && (
    // Pin positions are in the image's own pixels.
    <PinTargets {...props} width={size.width} height={size.height} anchors={anchors && { ...anchors, onOpenPin: (_m, i, n) => open(i, n) }} />
  )

  return (
    <figure className="capture-figure">
      <div className="capture-frame">
        <img
          src={src}
          alt={pins.length ? `Screenshot with ${pins.length} ${pins.length === 1 ? 'pin' : 'pins'}` : image.name}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onClick={() => setEnlarged(true)}
        />
        {targets}
      </div>
      {pins.length > 0 && (
        <ol className="pin-notes">
          {pins.map((p, i) => {
            const n = i + 1
            const thread = anchors?.threadOf(message.id, index, n)
            const active = anchors?.active?.messageId === message.id && anchors.active.image === index && anchors.active.pin === n
            return (
              <li key={i}>
                <button className={active ? 'active' : undefined} disabled={!anchors} onClick={() => anchors?.onOpenPin(message, index, n)}>
                  <span className="pin-number">{n}</span>
                  <span className={p.note ? 'pin-note' : 'pin-note empty'}>{p.note || 'No note'}</span>
                  {thread && thread.replies > 0 && (
                    <span className="anchor-chip">
                      <MessageSquare size={12} />
                      {thread.replies}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>
      )}
      {enlarged &&
        createPortal(
          <div className="capture-lightbox" onClick={(e) => e.target === e.currentTarget && setEnlarged(false)}>
            <button className="icon-button capture-lightbox-close" aria-label="Close" title="Close (Esc)" onClick={() => setEnlarged(false)}>
              <X />
            </button>
            <div className="capture-frame">
              <img src={src} alt="" />
              {targets}
            </div>
            <p className="capture-lightbox-hint">{pins.length > 0 ? 'Click a pin to open its thread · Esc to close' : 'Esc to close'}</p>
          </div>,
          document.body
        )}
    </figure>
  )
}

/** The part of the screenshot around a pin, for a pin thread's quote (SPEC → Visual feedback). */
export function PinCrop({ image, pin }: { image: Image; pin: number }): React.JSX.Element | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const p = image.pins?.[pin - 1]
  const src = `data:${image.mimeType};base64,${image.data}`
  useEffect(() => {
    const img = new Image()
    img.onload = () => setSize({ width: img.naturalWidth, height: img.naturalHeight })
    img.src = src
  }, [src])
  if (!p) return null
  // A 120 × 72 window on the image at half size, centered on the pin where the edges allow.
  const w = 120
  const h = 72
  const k = 0.5
  const iw = (size?.width ?? 0) * k
  const ih = (size?.height ?? 0) * k
  const x = Math.max(0, Math.min(iw - w, p.x * k - w / 2))
  const y = Math.max(0, Math.min(ih - h, p.y * k - h / 2))
  return (
    <span
      className="pin-crop"
      role="img"
      aria-label={`The screenshot around pin ${pin}`}
      style={size ? { backgroundImage: `url("${src}")`, backgroundSize: `${iw}px ${ih}px`, backgroundPosition: `${-x}px ${-y}px` } : undefined}
    />
  )
}
