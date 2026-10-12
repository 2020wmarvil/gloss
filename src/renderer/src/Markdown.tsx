// Renders untrusted agent markdown. No raw HTML (it is shown as text), only
// absolute web and mailto links (opened in the system browser by the main
// process), and no images are loaded.
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

const components: Components = {
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

export function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
