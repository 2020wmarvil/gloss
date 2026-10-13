// Renders untrusted agent markdown. No raw HTML (it is shown as text), only
// absolute web and mailto links (opened in the system browser by the main
// process), and no images are loaded. Code blocks are highlighted and have a
// copy button.
import { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { itemMarker, listItemSpans, type ListItemSpan } from './anchors'
import { codeColors, useHighlighting } from './highlight'
import { remarkSourceSpans, type Mark } from './sourceSpans'

type Node = { type: string; children?: Node[] }
type HastNode = { type: string; value?: string; children?: HastNode[] }

function textOf(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function CodeBlock({ code, children }: { code: string; children: React.ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="code-block">
      <pre>{children}</pre>
      <button
        type="button"
        className="copy-code"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

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
  img: ({ alt }) => <span className="md-image">[image{alt ? `: ${alt}` : ''}]</span>,
  // The code's text without a trailing newline (the code node's value).
  pre: ({ node, children }) => <CodeBlock code={textOf(node as HastNode).replace(/\n$/, '')}>{children}</CodeBlock>
}

/** Thread anchors in one agent message: reply affordances, marked selections. */
export type MessageAnchors = {
  /** Replies in the thread on each top-level list item, by item index. */
  replyCount(index: number): number
  activeIndex: number | null
  /** The item whose thread has a running turn. */
  runningIndex: number | null
  onOpenItem(span: ListItemSpan): void
  /** Selection anchors (and a draft one) to mark. */
  marks: Mark[]
  /** Replies in a thread, by thread id. */
  threadCount(threadId: string): number
  runningThread: string | null
  onOpenThread(threadId: string): void
}

const replyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

function anchorComponents(text: string, anchors: MessageAnchors): Components {
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
              onClick={() => anchors.onOpenItem(span)}
            >
              {running ? <span className="running-dot" aria-label="Running" /> : replyIcon}
              <span>{count > 0 ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'Reply'}</span>
            </button>
          </div>
        </li>
      )
    },
    span: ({ node, className, children, ...props }) => {
      const threadId = (props as Record<string, unknown>)['data-thread'] as string | undefined
      const classes = className?.split(' ') ?? []
      if (threadId && classes.includes('anchor-chip')) {
        const count = anchors.threadCount(threadId)
        return (
          <button
            type="button"
            className="anchor-chip"
            title={typeof props.title === 'string' ? `“${props.title}”` : undefined}
            aria-label={`Open thread, ${count} ${count === 1 ? 'reply' : 'replies'}`}
            onClick={() => anchors.onOpenThread(threadId)}
          >
            {anchors.runningThread === threadId ? <span className="running-dot" aria-label="Running" /> : replyIcon}
            {count}
          </button>
        )
      }
      if (threadId && classes.includes('anchored')) {
        return (
          <span
            {...props}
            className={className}
            onClick={() => {
              // A click opens the thread; a drag that selects text does not.
              if (window.getSelection()?.isCollapsed !== false) anchors.onOpenThread(threadId)
            }}
          >
            {children}
          </span>
        )
      }
      return (
        <span {...props} className={className}>
          {children}
        </span>
      )
    }
  }
}

export function Markdown({ text, anchors }: { text: string; anchors?: MessageAnchors }): React.JSX.Element {
  // Re-render when highlighting for more languages becomes available.
  useHighlighting()
  return (
    <div className={anchors ? 'md with-anchors' : 'md'}>
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkHtmlAsText,
          [remarkSourceSpans, { marks: anchors?.marks ?? [], colors: codeColors }]
        ]}
        components={anchors ? anchorComponents(text, anchors) : baseComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
