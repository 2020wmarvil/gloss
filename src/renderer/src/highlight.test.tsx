// @vitest-environment jsdom
import ReactMarkdown from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { remarkSourceSpans, type CodeColors } from './sourceSpans'

// Colors every "x" red, as a stand-in for a highlighter.
const fakeColors: CodeColors = (code, lang) => (lang === 'js' ? [...code].map((c) => (c === 'x' ? '#f00' : undefined)) : null)

function render(markdown: string): HTMLElement {
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[[remarkSourceSpans, { marks: [], colors: fakeColors }]]}>{markdown}</ReactMarkdown>
  )
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

describe('code highlighting', () => {
  it('splits code into colored spans that keep their source offsets', () => {
    const source = 'Intro\n\n```js\nlet x = 1\n```\n'
    const spans = [...render(source).querySelectorAll('pre code span[data-src]')] as HTMLElement[]
    expect(spans.map((s) => s.textContent)).toEqual(['let ', 'x', ' = 1'])
    expect(spans.map((s) => s.style.color)).toEqual(['', 'rgb(255, 0, 0)', ''])
    for (const s of spans) {
      const start = Number(s.dataset.src)
      const end = Number(s.dataset.srcEnd)
      expect(source.slice(start, end)).toBe(s.textContent)
    }
  })

  it('leaves code plain when the language is not available', () => {
    const spans = render('```rust\nlet x = 1\n```').querySelectorAll('pre code span[data-src]')
    expect([...spans].map((s) => s.textContent)).toEqual(['let x = 1'])
  })
})
