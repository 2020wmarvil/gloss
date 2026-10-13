// A remark plugin that renders every run of text as spans carrying their source
// offsets (data-src, data-src-end), so a DOM selection can be mapped back to the
// source markdown. It also splits runs at selection-anchor boundaries to mark
// anchored text and adds a count chip after each anchor, and colors code blocks
// (the highlight token spans carry source offsets like any other run).
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
  /** Tooltip for the chip (the anchored text). */
  title?: string
}

type TextNode = {
  type: 'text' | 'inlineCode' | 'code'
  value: string
  lang?: string | null
  position?: Nodes['position']
  data?: Record<string, unknown>
}

/** Per-character colors for a code block's text, or null to leave it plain. */
export type CodeColors = (code: string, lang: string | null | undefined) => (string | undefined)[] | null

const TEXT_TYPES = new Set(['text', 'inlineCode', 'code'])

export function remarkSourceSpans(options: { marks: Mark[]; colors?: CodeColors }) {
  const { marks, colors: colorsFor } = options
  return (tree: Root, file: { value: unknown }): void => {
    const source = String(file.value)

    type Parent = { children: Nodes[] }
    const runs: { node: TextNode; offsets: number[]; parent: Parent | null }[] = []
    const walk = (node: Nodes, parent: Parent | null): void => {
      if (TEXT_TYPES.has(node.type) && 'value' in node) {
        const offsets = nodeOffsets(source, node)
        if (offsets) runs.push({ node: node as TextNode, offsets, parent })
        return
      }
      if ('children' in node) for (const child of node.children) walk(child as Nodes, node as Parent)
    }
    walk(tree, null)

    const chip = (m: Mark): ElementContent => ({
      type: 'element',
      tagName: 'span',
      properties: { className: ['anchor-chip'], dataThread: m.threadId, ...(m.title ? { title: m.title } : {}) },
      children: []
    })
    // Chips for anchors ending inside code go after the code, not inside it:
    // right after inline code, in a row below a code block.
    const after: { parent: Parent; node: TextNode; chips: ElementContent[] }[] = []

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

    runs.forEach(({ node, offsets, parent }, r) => {
      const children: ElementContent[] = []
      const outside: ElementContent[] = []
      const colors = node.type === 'code' ? (colorsFor?.(node.value, node.lang) ?? null) : null
      let i0 = 0
      for (let i = 1; i <= offsets.length; i++) {
        if (
          i < offsets.length &&
          markAt(offsets[i]) === markAt(offsets[i0]) &&
          (!colors || colors[i] === colors[i0])
        ) {
          continue
        }
        const mark = markAt(offsets[i0])
        const color = colors?.[i0]
        children.push({
          type: 'element',
          tagName: 'span',
          properties: {
            dataSrc: offsets[i0],
            dataSrcEnd: offsets[i - 1] + 1,
            ...(color ? { style: `color:${color}` } : {}),
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
            ;(node.type === 'text' || !parent ? children : outside).push(chip(m))
          }
        }
        i0 = i
      }
      if (outside.length > 0 && parent) after.push({ parent, node, chips: outside })
      node.data = {
        ...node.data,
        ...(node.type === 'text' ? { hName: 'span' } : {}),
        hChildren: children
      }
    })

    for (const { parent, node, chips } of after.reverse()) {
      const index = parent.children.indexOf(node as Nodes)
      const holder = {
        type: 'text',
        value: '',
        data: node.type === 'code'
          ? { hName: 'div', hProperties: { className: ['anchor-chips'] }, hChildren: chips }
          : { hName: 'span', hChildren: chips }
      } as unknown as Nodes
      parent.children.splice(index + 1, 0, holder)
    }
  }
}
