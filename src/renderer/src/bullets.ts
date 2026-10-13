// Bulleted lists in the composer (SPEC → Composer → Bullets): "* " at the start of a line
// becomes a bullet, Shift+Enter continues the list, and the message goes out as markdown.

export const BULLET = '•'

/** Replace `text.slice(start, end)` with `insert`; the caret ends up after it. */
export type Edit = { start: number; end: number; insert: string }

/** The line around `caret`: where it starts and the text before and after the caret. */
function lineAt(text: string, caret: number): { start: number; before: string; after: string } {
  const start = text.lastIndexOf('\n', caret - 1) + 1
  const nl = text.indexOf('\n', caret)
  return { start, before: text.slice(start, caret), after: text.slice(caret, nl === -1 ? text.length : nl) }
}

/** Typing a space right after a leading "*" turns it into a bullet. */
export function bulletOnSpace(text: string, caret: number): Edit | null {
  const { start, before } = lineAt(text, caret)
  const m = /^(\s*)\*$/.exec(before)
  return m ? { start: start + m[1].length, end: caret, insert: `${BULLET} ` } : null
}

/** Shift+Enter on a bullet line starts the next bullet; on an empty one it ends the list. */
export function bulletOnNewline(text: string, caret: number): Edit | null {
  const { start, before, after } = lineAt(text, caret)
  const m = new RegExp(`^(\\s*)${BULLET} `).exec(before)
  if (!m) return null
  if (before.length === m[0].length && !after.trim()) return { start, end: caret, insert: '' }
  return { start: caret, end: caret, insert: `\n${m[1]}${BULLET} ` }
}

/** Backspace right after a bullet removes it, keeping the line's text. */
export function bulletOnBackspace(text: string, caret: number): Edit | null {
  const { start, before } = lineAt(text, caret)
  const m = new RegExp(`^(\\s*)${BULLET} $`).exec(before)
  return m ? { start: start + m[1].length, end: caret, insert: '' } : null
}

/** The text with its bullets as markdown list items, for sending. */
export function bulletsToMarkdown(text: string): string {
  return text.replace(new RegExp(`^(\\s*)${BULLET} `, 'gm'), '$1- ')
}

export type TextBlock = { kind: 'text'; text: string } | { kind: 'list'; items: string[] }

/**
 * A user message split into plain text and bulleted lists ("- ", "* " or "• " at the
 * start of a line), so it shows its lists. Lines inside ``` fences are left alone.
 */
export function splitLists(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const m = fenced ? null : /^\s*[-*•] (.*)$/.exec(line)
    const last = blocks.at(-1)
    if (m) {
      if (last?.kind === 'list') last.items.push(m[1])
      else blocks.push({ kind: 'list', items: [m[1]] })
    } else if (last?.kind === 'text') last.text += `\n${line}`
    else blocks.push({ kind: 'text', text: line })
  }
  return blocks
}
