// Finds anchorable spans in an agent message's source markdown.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes, Root } from 'mdast'

export type ListItemSpan = {
  /** Index among the message's top-level list items, in document order (Anchor path [index]). */
  index: number
  /** Source offsets of the item, including its list marker. */
  start: number
  end: number
  /** The item's plain text, whitespace collapsed. */
  text: string
}

const parser = unified().use(remarkParse).use(remarkGfm)

const cache = new Map<string, Root>()
const CACHE_SIZE = 200

/** Parses markdown into mdast (with source positions), caching recent results. */
export function parseMarkdown(markdown: string): Root {
  let tree = cache.get(markdown)
  if (!tree) {
    tree = parser.runSync(parser.parse(markdown)) as Root
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
    cache.set(markdown, tree)
  }
  return tree
}

export function plainText(node: Nodes): string {
  const parts: string[] = []
  const walk = (n: Nodes): void => {
    if ('value' in n && typeof n.value === 'string') parts.push(n.value)
    if ('children' in n) {
      for (const child of n.children) {
        walk(child as Nodes)
        // Separate block-level children (paragraphs, nested items) with a space.
        if (child.type === 'paragraph' || child.type === 'listItem' || child.type === 'list') parts.push(' ')
      }
    }
  }
  walk(node)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/** Top-level list items: items of lists that are direct children of the document. */
export function listItemSpans(markdown: string): ListItemSpan[] {
  const spans: ListItemSpan[] = []
  for (const block of parseMarkdown(markdown).children) {
    if (block.type !== 'list') continue
    for (const item of block.children) {
      const start = item.position?.start.offset
      const end = item.position?.end.offset
      if (start === undefined || end === undefined) continue
      spans.push({ index: spans.length, start, end, text: plainText(item) })
    }
  }
  return spans
}

/** The item's source without its list marker, for quoting it as markdown. */
export function itemSource(markdown: string, span: ListItemSpan): string {
  return markdown.slice(span.start, span.end).replace(/^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '')
}
