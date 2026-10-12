// A remark plugin that renders every run of text as spans carrying their source
// offsets (data-src, data-src-end), so a DOM selection can be mapped back to the
// source markdown. It also splits runs at selection-anchor boundaries to mark
// anchored text and adds a count chip after each anchor.
import type { ElementContent } from 'hast'
import type { Nodes, Root } from 'mdast'
import { nodeOffsets } from './source'

/** A source range to mark in the rendered message. */
export type Mark = {
  start: number
  end: number
  /** null for a draft anchor (no thread yet): highlighted, no chip. */
  threadId: string | null
  /** Extra classes, e.g. "active". */
  className?: string
}

type TextNode = { type: 'text' | 'inlineCode' | 'code'; value: string; position?: Nodes['position']; data?: Record<string, unknown> }

const TEXT_TYPES = new Set(['text', 'inlineCode', 'code'])

export function remarkSourceSpans(options: { marks: Mark[] }) {
  const { marks } = options
  return (tree: Root, file: { value: unknown }): void => {
    const source = String(file.value)

    const runs: { node: TextNode; offsets: number[] }[] = []
    const walk = (node: Nodes): void => {
      if (TEXT_TYPES.has(node.type) && 'value' in node) {
        const offsets = nodeOffsets(source, node)
        if (offsets) runs.push({ node: node as TextNode, offsets })
        return
      }
      if ('children' in node) for (const child of node.children) walk(child as Nodes)
    }
    walk(tree)

    // The innermost (shortest) mark covering a source offset.
    const markAt = (o: number): Mark | null => {
      let best: Mark | null = null
      for (const m of marks) {
        if (o >= m.start && o < m.end && (!best || m.end - m.start < best.end - best.start)) best = m
      }
      return best
    }

    // Where each mark's last rendered character is, to place its chip.
    const lastChar = new Map<Mark, string>()
    runs.forEach((run, r) =>
      run.offsets.forEach((o, i) => {
        for (const m of marks) if (o >= m.start && o < m.end) lastChar.set(m, `${r}:${i}`)
      })
    )

    runs.forEach(({ node, offsets }, r) => {
      const children: ElementContent[] = []
      let i0 = 0
      for (let i = 1; i <= offsets.length; i++) {
        if (i < offsets.length && markAt(offsets[i]) === markAt(offsets[i0])) continue
        const mark = markAt(offsets[i0])
        children.push({
          type: 'element',
          tagName: 'span',
          properties: {
            dataSrc: offsets[i0],
            dataSrcEnd: offsets[i - 1] + 1,
            ...(mark
              ? {
                  className: ['anchored', ...(mark.threadId ? [] : ['pending']), ...(mark.className ? [mark.className] : [])],
                  ...(mark.threadId ? { dataThread: mark.threadId } : {})
                }
              : {})
          },
          children: [{ type: 'text', value: node.value.slice(i0, i) }]
        })
        for (const m of marks) {
          if (m.threadId && lastChar.get(m) === `${r}:${i - 1}`) {
            children.push({
              type: 'element',
              tagName: 'span',
              properties: { className: ['anchor-chip'], dataThread: m.threadId },
              children: []
            })
          }
        }
        i0 = i
      }
      node.data = {
        ...node.data,
        ...(node.type === 'text' ? { hName: 'span' } : {}),
        hChildren: children
      }
    })
  }
}
