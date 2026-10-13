// What a tool call did, from its ACP content: command output and other content as
// markdown, file edits as a diff.
import { diffLines } from 'diff'
import type { ToolCall } from '@shared/types'
import { Markdown } from './Markdown'

type Block = { type?: unknown; [key: string]: unknown }

/** Lines of unchanged context kept around each change. */
const CONTEXT = 3

type Line = { kind: 'add' | 'del' | 'same' | 'gap'; text: string }

/** A unified line diff with long unchanged stretches collapsed. */
export function diffRows(oldText: string, newText: string): Line[] {
  const lines: Line[] = []
  // A last line without a newline would otherwise differ from the same line with one.
  const withNewline = (t: string): string => (t === '' || t.endsWith('\n') ? t : `${t}\n`)
  for (const part of diffLines(withNewline(oldText), withNewline(newText))) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'same'
    const texts = part.value.replace(/\n$/, '').split('\n')
    for (const text of texts) lines.push({ kind, text })
  }
  const keep = lines.map((l) => l.kind !== 'same')
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = true
  })
  const out: Line[] = []
  let skipped = 0
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
      skipped = 0
      out.push(l)
    } else {
      skipped++
    }
  })
  if (skipped) out.push({ kind: 'gap', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
  return out
}

function Diff({ path, oldText, newText }: { path: string; oldText: string; newText: string }): React.JSX.Element {
  const rows = diffRows(oldText, newText)
  return (
    <div className="diff">
      <div className="diff-path mono">{path}</div>
      <pre>
        {rows.map((r, i) => (
          <div key={i} className={`diff-${r.kind}`}>
            <span className="diff-sign" aria-hidden>
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : r.kind === 'gap' ? '⋯' : ' '}
            </span>
            {r.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

function ContentBlock({ block }: { block: Block }): React.JSX.Element | null {
  if (block.type === 'text' && typeof block.text === 'string') return <Markdown text={block.text} />
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
    return <img className="tool-image" src={`data:${block.mimeType};base64,${block.data}`} alt="" />
  }
  if (block.type === 'resource_link' && typeof block.uri === 'string') return <p className="mono">{block.uri}</p>
  if (block.type === 'resource') {
    const r = block.resource as Block | undefined
    if (r && typeof r.text === 'string') return <Markdown text={'```\n' + r.text + '\n```'} />
  }
  return null
}

/** Whether a tool call has anything to show when expanded. */
export function hasDetails(toolCall: ToolCall): boolean {
  return toolCall.kind === 'execute' || (Array.isArray(toolCall.content) && toolCall.content.length > 0)
}

export function ToolDetails({ toolCall }: { toolCall: ToolCall }): React.JSX.Element {
  const content = (Array.isArray(toolCall.content) ? toolCall.content : []) as Block[]
  return (
    <div className="tool-details">
      {toolCall.kind === 'execute' && <pre className="tool-command">{toolCall.title}</pre>}
      {content.map((item, i) => {
        if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') {
          return <Diff key={i} path={item.path} oldText={typeof item.oldText === 'string' ? item.oldText : ''} newText={item.newText} />
        }
        if (item.type === 'content' && item.content && typeof item.content === 'object') {
          return <ContentBlock key={i} block={item.content as Block} />
        }
        if (item.type === 'terminal') {
          return (
            <p key={i} className="muted">
              The output went to a terminal, which Gloss doesn&apos;t show.
            </p>
          )
        }
        return null
      })}
      {toolCall.kind === 'execute' && content.length === 0 && (
        <p className="muted">{toolCall.status === 'completed' ? 'No output.' : 'No output yet.'}</p>
      )}
    </div>
  )
}
