// Renders untrusted agent markdown. No raw HTML (it is shown as text), only
// absolute web and mailto links (opened in the system browser by the main
// process), and no images are loaded.
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { itemMarker, listItemSpans, type ListItemSpan } from './anchors'

type Node = { type: string; children?: Node[] }

/** Turns raw HTML nodes into plain text so they are displayed, not rendered. */
function remarkHtmlAsText() {
  const walk = (node: Node): void => {
    if (node.type === 'html') node.type = 'text'
    node.children?.forEach(walk)
  }
  return (tree: Node) => walk(tree)
}

const SAFE_LINK = /^(https?:|mailto:)/i

const baseComponents: Components = {
  a: ({ href, children }) =>
    href && SAFE_LINK.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener" title={href}>
        {children}
      </a>
    ) : (
      <span className="md-link-text" title={href}>
        {children}
      </span>
    ),
  img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ''}]</span>
}

/** Reply affordances on a message's top-level list items. */
export type ItemAnchors = {
  /** Replies in the thread on each item, by item index. */
  replyCount(index: number): number
  activeIndex: number | null
  /** The item whose thread has a running turn. */
  runningIndex: number | null
  onOpen(span: ListItemSpan): void
}

const replyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

function itemComponents(text: string, anchors: ItemAnchors): Components {
  const byStart = new Map(listItemSpans(text).map((s) => [s.start, s]))
  return {
    ...baseComponents,
    li: ({ node, children }) => {
      const offset = node?.position?.start.offset
      const span = offset === undefined ? undefined : byStart.get(offset)
      if (!span) return <li>{children}</li>
      const count = anchors.replyCount(span.index)
      const active = anchors.activeIndex === span.index
      const running = anchors.runningIndex === span.index
      const n = span.index + 1
      return (
        <li className={`anchor-item${active ? ' active' : ''}`}>
          <div className="anchor-row">
            <span className="anchor-marker" aria-hidden>
              {itemMarker(text, span)}
            </span>
            <div className="anchor-body">{children}</div>
            <button
              className={count > 0 ? 'badge' : 'reply'}
              aria-label={count > 0 ? `Open thread on item ${n}` : `Reply to item ${n}`}
              onClick={() => anchors.onOpen(span)}
            >
              {running ? <span className="running-dot" aria-label="Running" /> : replyIcon}
              <span>{count > 0 ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'Reply'}</span>
            </button>
          </div>
        </li>
      )
    }
  }
}

export function Markdown({ text, items }: { text: string; items?: ItemAnchors }): React.JSX.Element {
  return (
    <div className={items ? 'md anchored' : 'md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkHtmlAsText]}
        components={items ? itemComponents(text, items) : baseComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
