// The composer's text box: a CodeMirror markdown editor (SPEC → Composer → Markdown).
// The source stays visible but is styled, lists continue, and a few keys format the
// selection. What the user sees is exactly what the agent receives.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { history, historyKeymap, standardKeymap } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, Prec, type ChangeSpec, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { tags } from '@lezer/highlight'

export type MarkdownEditorHandle = {
  focus(): void
  selection(): [number, number]
  setSelection(anchor: number, head: number): void
}

type Props = {
  value: string
  onChange(value: string): void
  placeholder: string
  ariaLabel: string
  /** Runs before the editor's own keys; return true when it handled the key. */
  onKeyDown?(e: KeyboardEvent): boolean
  /** Enter outside a code block (`send`), or Ctrl/Cmd+Enter (`steer`). */
  onSubmit(how: 'send' | 'steer'): void
  /** The caret or selection moved without an edit (a click, an arrow key). */
  onSelectionChange?(): void
  /** Files pasted into the editor; return true when they were taken. */
  onPasteFiles?(files: File[]): boolean
  ref?: Ref<MarkdownEditorHandle>
}

/** The cursor is inside a fenced code block (one that is still open, or before its closing fence). */
export function inCodeBlock(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name !== 'FencedCode') continue
    const marks = node.getChildren('CodeMark')
    return marks.length < 2 || pos < marks[marks.length - 1].from
  }
  return false
}

const continueList = insertNewlineContinueMarkupCommand({ nonTightLists: false })

const newline: StateCommand = ({ state, dispatch }) => {
  dispatch(state.update(state.replaceSelection('\n'), { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** Wraps each selection in `mark` (or unwraps it if it already is); an empty one gets a pair with the cursor inside. */
export function toggleWrap(mark: string): StateCommand {
  return ({ state, dispatch }) => {
    const n = mark.length
    dispatch(
      state.update(
        state.changeByRange((range) => {
          const text = state.sliceDoc(range.from, range.to)
          const before = state.sliceDoc(range.from - n, range.from)
          const after = state.sliceDoc(range.to, range.to + n)
          if (before === mark && after === mark) {
            return {
              changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
              range: EditorSelection.range(range.from - n, range.to - n)
            }
          }
          if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
            return {
              changes: { from: range.from, to: range.to, insert: text.slice(n, -n) },
              range: EditorSelection.range(range.from, range.to - 2 * n)
            }
          }
          return {
            changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
            range: EditorSelection.range(range.from + n, range.to + n)
          }
        }),
        { userEvent: 'input' }
      )
    )
    return true
  }
}

/** Makes the selection a link and selects the URL to type over; an empty selection gets `[](url)` with the cursor in the text. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  dispatch(
    state.update(
      state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to)
        const insert = `[${text}](url)`
        const urlFrom = range.from + text.length + 3
        return {
          changes: { from: range.from, to: range.to, insert },
          range: text ? EditorSelection.range(urlFrom, urlFrom + 3) : EditorSelection.cursor(range.from + 1)
        }
      }),
      { userEvent: 'input' }
    )
  )
  return true
}

/** The list item the cursor's line starts, if any. */
function listItemAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'ListItem') return node
  }
  return null
}

/** Where an item's text starts on its line: its indent, marker and the spaces after it. */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from)
  const mark = item.getChild('ListMark')
  if (!mark) return item.from - line.from
  const rest = state.sliceDoc(mark.to, line.to)
  const spaces = Math.min(4, Math.max(1, rest.length - rest.trimStart().length))
  return mark.to - line.from + spaces
}

/** An ordered item's number; 0 for a bullet. */
function itemNumber(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild('ListMark')
  const digits = mark ? /^\d+/.exec(state.sliceDoc(mark.from, mark.to)) : null
  return digits ? Number(digits[0]) : 0
}

function indentOf(state: EditorState, pos: number): number {
  const text = state.doc.lineAt(pos).text
  return text.length - text.trimStart().length
}

/**
 * Tab nests the cursor's list item under the one before it, Shift+Tab moves it out to
 * its parent's level, together with its own lines and sub-items. Outside a list it does
 * nothing, so Tab keeps moving focus.
 */
export function shiftListItem(dir: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    const item = listItemAt(state, state.selection.main.head)
    if (!item) return false
    const current = indentOf(state, item.from)
    let target: number
    // An ordered item takes the number that fits where it lands: a nested list has to
    // start at 1, or it can't interrupt the item's text and stays part of it.
    let number: number
    if (dir === 1) {
      let prev = item.prevSibling
      while (prev && prev.name !== 'ListItem') prev = prev.prevSibling
      // The first item can't nest under anything: keep Tab from leaving the editor anyway.
      if (!prev) return true
      target = contentColumn(state, prev)
      const sub = prev.getChild('OrderedList')?.lastChild
      number = sub ? itemNumber(state, sub) + 1 : 1
    } else {
      const parent = item.parent?.parent
      if (!parent || parent.name !== 'ListItem') return true
      target = indentOf(state, parent.from)
      number = itemNumber(state, parent) + 1
    }
    const delta = target - current
    if (delta === 0) return true
    const first = state.doc.lineAt(item.from).number
    const last = state.doc.lineAt(item.to).number
    const changes: ChangeSpec[] = []
    const mark = item.getChild('ListMark')
    const digits = mark ? /^\d+/.exec(state.sliceDoc(mark.from, mark.to)) : null
    if (mark && digits && number > 0) changes.push({ from: mark.from, to: mark.from + digits[0].length, insert: String(number) })
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      if (delta > 0) changes.push({ from: line.from, insert: ' '.repeat(delta) })
      else changes.push({ from: line.from, to: line.from + Math.min(-delta, indentOf(state, line.from)) })
    }
    dispatch(state.update({ changes, userEvent: 'input' }))
    return true
  }
}

const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '600', fontSize: '1.2em' },
  { tag: tags.heading2, fontWeight: '600', fontSize: '1.1em' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--mono)', fontSize: '0.92em' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--faint)' }
])

/** The selection in the app's colors; CodeMirror's own rules need its selectors to override. */
const theme = EditorView.theme({
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'var(--accent-tint-4)'
  }
})

export function MarkdownEditor(props: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** Kept after the view is gone, so a draft can save it while unmounting. */
  const lastSelection = useRef<[number, number]>([0, 0])
  // The editor is built once; its handlers read the latest props.
  const latest = useRef(props)
  latest.current = props

  useImperativeHandle(props.ref, () => ({
    focus: () => view.current?.focus(),
    selection: () => lastSelection.current,
    setSelection: (anchor, head) => {
      const v = view.current
      if (!v) return
      const max = v.state.doc.length
      v.dispatch({ selection: EditorSelection.single(Math.min(anchor, max), Math.min(head, max)) })
    }
  }))

  // A layout effect, so the editor exists when the composer restores a draft's caret.
  useLayoutEffect(() => {
    const submit = (how: 'send' | 'steer'): StateCommand => ({ state }) => {
      if (how === 'send' && inCodeBlock(state, state.selection.main.head)) return false
      latest.current.onSubmit(how)
      return true
    }
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          placeholderExt(latest.current.placeholder),
          EditorView.contentAttributes.of({ 'aria-label': latest.current.ariaLabel, 'aria-multiline': 'true' }),
          markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
          syntaxHighlighting(highlight),
          theme,
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e) => latest.current.onKeyDown?.(e) ?? false,
              paste: (e) => {
                const files = [...(e.clipboardData?.files ?? [])]
                if (files.length === 0 || !latest.current.onPasteFiles) return false
                if (latest.current.onPasteFiles(files)) e.preventDefault()
                return true
              },
              // Dropped files are attachments (the composer handles the drop), never text.
              drop: (e) => (e.dataTransfer?.files.length ?? 0) > 0
            })
          ),
          Prec.high(
            keymap.of([
              { key: 'Enter', run: submit('send') },
              { key: 'Enter', run: newline },
              { key: 'Mod-Enter', run: submit('steer') },
              { key: 'Shift-Enter', run: (target) => continueList(target) || newline(target) },
              { key: 'Backspace', run: deleteMarkupBackward },
              { key: 'Tab', run: shiftListItem(1) },
              { key: 'Shift-Tab', run: shiftListItem(-1) },
              { key: 'Mod-b', run: toggleWrap('**') },
              { key: 'Mod-i', run: toggleWrap('*') },
              { key: 'Mod-e', run: toggleWrap('`') },
              { key: 'Mod-k', run: insertLink }
            ])
          ),
          keymap.of([...standardKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            const main = u.state.selection.main
            lastSelection.current = [main.anchor, main.head]
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
            else if (u.selectionSet) latest.current.onSelectionChange?.()
          })
        ]
      })
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [])

  // Text set from outside (cleared after sending, a completed slash command) replaces the document.
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === props.value) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value }, selection: EditorSelection.cursor(props.value.length) })
  }, [props.value])

  return <div ref={host} className="md-editor" />
}
