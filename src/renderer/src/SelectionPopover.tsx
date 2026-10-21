// "Reply to selection" popover for text selected in a main-view agent message.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Message } from '@shared/types'
import { rangeToSource } from './selection'
import { renderedText } from './source'
import { Reply } from 'lucide-react'

export type SourceSelection = { start: number; end: number; text: string }

type Current = SourceSelection & { message: Message; top: number; left: number; bottom: number }

type Props = {
  /** The element containing the main log; selections elsewhere are ignored. */
  scope: RefObject<HTMLElement | null>
  messages: Message[]
  onReply(message: Message, selection: SourceSelection): void
}

const POPOVER_WIDTH = 270
const POPOVER_HEIGHT = 42

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
  )
}

export function SelectionPopover({ scope, messages, onReply }: Props): React.JSX.Element | null {
  const [current, setCurrent] = useState<Current | null>(null)
  const frame = useRef(0)

  const compute = useCallback(() => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || s.rangeCount === 0) return setCurrent(null)
    const range = s.getRangeAt(0)
    const container = range.commonAncestorContainer
    const el = container instanceof Element ? container : container.parentElement
    const root = el?.closest<HTMLElement>('[data-message-id]')
    if (!root || !scope.current?.contains(root)) return setCurrent(null)
    const message = messages.find((m) => m.id === root.dataset.messageId)
    if (!message || message.role !== 'agent') return setCurrent(null)
    const r = rangeToSource(root, range, message.text)
    const text = r ? renderedText(message.text, r.start, r.end) : ''
    if (!r || !text) return setCurrent(null)
    const rect = range.getBoundingClientRect()
    setCurrent({ ...r, text, message, top: rect.top, left: rect.left, bottom: rect.bottom })
  }, [scope, messages])

  useEffect(() => {
    const schedule = (): void => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(compute)
    }
    document.addEventListener('selectionchange', schedule)
    // Keep the popover next to the selection while the log scrolls.
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame.current)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [compute])

  const reply = useCallback(() => {
    if (!current) return
    const { message, start, end, text } = current
    window.getSelection()?.removeAllRanges()
    setCurrent(null)
    onReply(message, { start, end, text })
  }, [current, onReply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!current || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        reply()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, reply])

  if (!current) return null
  // Above the selection, or below it when there is no room.
  const top = current.top - POPOVER_HEIGHT - 8 >= 8 ? current.top - POPOVER_HEIGHT - 8 : current.bottom + 8
  const left = Math.max(8, Math.min(current.left, window.innerWidth - POPOVER_WIDTH - 8))
  return (
    <div
      className="selection-popover"
      role="toolbar"
      aria-label="Selection"
      style={{ top, left }}
      // Keep the selection when a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className="go" onClick={reply}>
        <Reply />
        Reply to selection <kbd>R</kbd>
      </button>
      <button className="copy" onClick={() => document.execCommand('copy')}>
        Copy
      </button>
    </div>
  )
}
