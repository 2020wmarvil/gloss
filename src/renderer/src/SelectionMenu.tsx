// The context menu for text selected in a main-view agent message: right-clicking the
// selection, or right-clicking (and dragging over) lines to select them, opens it.
import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { Message } from '@shared/types'
import { rangeToSource } from './selection'
import { renderedText } from './source'
import { useRightButtonLines, visualLineAt, type LineBounds } from './lineSelect'
import { modKey } from './shortcuts'

export type SourceSelection = { start: number; end: number; text: string }

type Current = SourceSelection & { message: Message }

type Props = {
  /** The element containing the main log; selections elsewhere are ignored. */
  scope: RefObject<HTMLElement | null>
  messages: Message[]
  onReply(message: Message, selection: SourceSelection): void
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')
  )
}

export type MenuItem = { label: string; keys?: string; run(): void }

/** A menu at the pointer that keeps the selection while choosing; clicks elsewhere, scrolling and Escape close it. */
export function SelectionContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose(): void }): React.JSX.Element {
  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('wheel', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div
      className="menu file-menu selection-menu"
      role="menu"
      style={{ left: Math.min(props.x, window.innerWidth - 208), top: Math.min(props.y, window.innerHeight - 8 - 36 * props.items.length) }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          aria-keyshortcuts={item.keys}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          <span>{item.label}</span>
          {item.keys && <kbd>{item.keys}</kbd>}
        </button>
      ))}
    </div>
  )
}

export const copySelection = (): void => {
  document.execCommand('copy')
}

/** The agent message a node is in, inside `scope`. */
function agentRoot(node: Node, scope: HTMLElement | null, messages: Message[]): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement
  const root = el?.closest<HTMLElement>('[data-message-id]')
  if (!root || !scope?.contains(root)) return null
  return messages.find((m) => m.id === root.dataset.messageId)?.role === 'agent' ? root : null
}

export function SelectionMenu({ scope, messages, onReply }: Props): React.JSX.Element | null {
  const [menu, setMenu] = useState<{ x: number; y: number; current: Current } | null>(null)

  const read = useCallback((): Current | null => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || s.rangeCount === 0) return null
    const range = s.getRangeAt(0)
    const root = agentRoot(range.commonAncestorContainer, scope.current, messages)
    const message = root && messages.find((m) => m.id === root.dataset.messageId)
    if (!root || !message) return null
    const r = rangeToSource(root, range, message.text)
    const text = r ? renderedText(message.text, r.start, r.end) : ''
    return r && text ? { ...r, text, message } : null
  }, [scope, messages])

  const lineAt = useCallback(
    (x: number, y: number, first: LineBounds | null) => {
      const line = visualLineAt(x, y, (n) => agentRoot(n, scope.current, messages))
      // A drag stays in the message it started in.
      return line && (!first || first.el === line.el) ? line : null
    },
    [scope, messages]
  )

  useRightButtonLines({
    scope,
    lineAt,
    onMenu: (x, y, first) => {
      const current = read()
      if (current) setMenu({ x, y, current })
      // A line with nothing to quote (a blank line, a button) isn't left selected.
      else if (first) window.getSelection()?.removeAllRanges()
    }
  })

  const reply = useCallback(
    (current: Current) => {
      const { message, start, end, text } = current
      window.getSelection()?.removeAllRanges()
      setMenu(null)
      onReply(message, { start, end, text })
    },
    [onReply]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || (e.key !== 'r' && e.key !== 'R')) return
      const current = read()
      if (!current) return
      e.preventDefault()
      reply(current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [read, reply])

  const close = useCallback(() => setMenu(null), [])
  if (!menu) return null
  return (
    <SelectionContextMenu
      x={menu.x}
      y={menu.y}
      onClose={close}
      items={[
        { label: 'Reply to selection', keys: 'R', run: () => reply(menu.current) },
        { label: 'Copy', keys: `${modKey()}+C`, run: copySelection }
      ]}
    />
  )
}
