// Renders untrusted agent markdown. No raw HTML (it is shown as text), only
// web/mail links and absolute local file links (opened through the main
// process), and local raster images loaded through the main process.
// Code blocks are highlighted and have a copy button.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { fileLink, isHtmlFile } from '../../shared/fileLink'
import { imageLink } from '../../shared/imageLink'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { listItemSpans, type ListItemSpan } from './anchors'
import { codeColors, useHighlighting } from './highlight'
import { remarkSourceSpans, type Mark } from './sourceSpans'
import { MessageSquare, Reply } from 'lucide-react'

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

function FileLink({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const action = isHtmlFile(fileLink(href)?.path ?? '') ? 'Open in default browser' : 'Open in external editor, or show in folder'
  return (
    <>
      <a href={href} title={`${action}: ${href}`} onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setError(null)
        void window.gloss.openFileLink(href).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      }}>{children}</a>
      {error && <span role="alert"> Couldn't open file: {error}</span>}
    </>
  )
}

export const MarkdownImageDirectory = createContext<string | undefined>(undefined)

function LocalImage({ src, alt, title }: { src?: string; alt?: string; title?: string }): React.JSX.Element {
  const cwd = useContext(MarkdownImageDirectory)
  const [result, setResult] = useState<{ src: string; cwd?: string; data?: string; error?: string } | null>(null)
  const local = src && imageLink(src) !== null
  useEffect(() => {
    if (!src || !local) return
    let active = true
    void window.gloss.readMarkdownImage(src, cwd).then(
      (data) => { if (active) setResult({ src, cwd, data }) },
      (error: unknown) => { if (active) setResult({ src, cwd, error: error instanceof Error ? error.message : String(error) }) }
    )
    return () => { active = false }
  }, [src, cwd, local])
  const current = result?.src === src && result?.cwd === cwd ? result : null
  if (current?.data && !current.error) return <img className="md-local-image" src={current.data} alt={alt ?? ''} title={title} onError={() => setResult({ src: src!, cwd, error: 'Image could not be decoded.' })} />
  return <span className="md-image" title={current?.error ?? src}>[image{alt ? `: ${alt}` : ''}]{current?.error && <span role="status"> {current.error}</span>}</span>
}

const baseComponents: Components = {
  a: ({ href, children }) =>
    href && fileLink(href) ? <FileLink href={href}>{children}</FileLink> : href && SAFE_LINK.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener" title={href}>
        {children}
      </a>
    ) : (
      <span className="md-link-text" title={href}>
        {children}
      </span>
    ),
  img: ({ src, alt, title }) => <LocalImage key={src} src={src} alt={alt} title={title} />,
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

const replyIcon = <MessageSquare size={12} />

function anchorComponents(spans: ListItemSpan[], anchors: MessageAnchors): Components {
  const byStart = new Map(spans.map((s) => [s.start, s]))
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
      // The list stays a list: Reply sits in the item's margin (shown on hover), and once
      // there are replies their count follows the item's last line, like a selection's.
      return (
        <li className={`anchor-item${active ? ' active' : ''}`}>
          <button
            className="item-reply"
            aria-label={count > 0 ? `Open thread on item ${n}` : `Reply to item ${n}`}
            title={count > 0 ? 'Open the thread' : 'Reply in a thread'}
            onClick={() => anchors.onOpenItem(span)}
          >
            <Reply />
          </button>
          {children}
          {(count > 0 || running) && (
            <button
              type="button"
              className="anchor-chip item-count"
              aria-label={`${count} ${count === 1 ? 'reply' : 'replies'}`}
              onClick={() => anchors.onOpenItem(span)}
            >
              {running ? <span className="running-dot" aria-label="Running" /> : replyIcon}
              {count}
            </button>
          )}
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

type MarkdownProps = { text: string; anchors?: MessageAnchors; breaks?: boolean; listItemReplies?: boolean }
type AnchorState = Pick<MessageAnchors, 'activeIndex' | 'runningIndex' | 'runningThread' | 'marks'> & {
  itemCounts: [number, number][]
  threadCounts: [string, number][]
}

/** `breaks`: a newline is a line break (the user's messages, typed as chat), not a space. */
export const Markdown = memo(function Markdown({ text, anchors, breaks, listItemReplies = true }: MarkdownProps): React.JSX.Element {
  const version = useHighlighting()
  const actions = useRef(anchors)
  actions.current = anchors
  const hasAnchors = anchors !== undefined
  const spans = useMemo(() => hasAnchors && listItemReplies ? listItemSpans(text) : [], [text, hasAnchors, listItemReplies])
  // Callbacks are fresh as the conversation updates. Only their visible results
  // belong in the parse cache; event handlers always use the latest callbacks.
  const state: AnchorState | null = anchors ? {
    activeIndex: anchors.activeIndex, runningIndex: anchors.runningIndex,
    runningThread: anchors.runningThread, marks: anchors.marks,
    itemCounts: spans.map((s) => [s.index, anchors.replyCount(s.index)]),
    threadCounts: [...new Set(anchors.marks.flatMap((m) => m.threadId === null ? [] : [m.threadId]))].map((id) => [id, anchors.threadCount(id)])
  } : null
  const stateKey = JSON.stringify(state)
  const stableAnchors = useMemo((): MessageAnchors | undefined => {
    const snapshot = JSON.parse(stateKey) as AnchorState | null
    if (!snapshot) return undefined
    const items = new Map(snapshot.itemCounts)
    const threads = new Map(snapshot.threadCounts)
    return {
      ...snapshot,
      replyCount: (index) => items.get(index) ?? 0,
      threadCount: (id) => threads.get(id) ?? 0,
      onOpenItem: (span) => actions.current?.onOpenItem(span),
      onOpenThread: (id) => actions.current?.onOpenThread(id)
    }
  }, [stateKey])
  return <ParsedMarkdown text={text} anchors={stableAnchors} breaks={breaks} listItemReplies={listItemReplies} spans={spans} version={version} />
})

/** Retain the parsed React tree until content, annotations or highlighting changes. */
const ParsedMarkdown = memo(function ParsedMarkdown({ text, anchors, breaks, listItemReplies, spans }: MarkdownProps & { spans: ListItemSpan[]; version: number }): React.JSX.Element {
  return (
    <div className={anchors && listItemReplies ? 'md with-anchors' : 'md'}>
      <ReactMarkdown
        urlTransform={(url, key) => key === 'src' ? (imageLink(url) !== null ? url : '') : fileLink(url) ? url : defaultUrlTransform(url)}
        remarkPlugins={[
          remarkGfm,
          ...(breaks ? [remarkBreaks] : []),
          remarkHtmlAsText,
          [remarkSourceSpans, { marks: anchors?.marks ?? [], colors: codeColors }]
        ]}
        components={anchors ? anchorComponents(spans, anchors) : baseComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
