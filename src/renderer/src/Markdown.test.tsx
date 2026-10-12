import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders lists, code and GFM tables', () => {
    const html = render('1. **One**\n2. `two`\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<ol>')
    expect(html).toContain('<strong>One</strong>')
    expect(html).toContain('<code>two</code>')
    expect(html).toContain('<table>')
  })

  it('shows raw HTML as text instead of rendering it', () => {
    const html = render('Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<iframe src="https://evil"></iframe>')
    expect(html).not.toMatch(/<img|<script|<iframe/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;iframe')
  })

  it('only links absolute web and mailto URLs', () => {
    const html = render('[web](https://example.com) [mail](mailto:a@b.c) [js](javascript:alert(1)) [rel](src/a.ts) [file](file:///etc/passwd)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('href="mailto:a@b.c"')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href="src/a.ts"')
    expect(html).not.toContain('href="file:')
    expect(html).toContain('target="_blank"')
  })

  it('never loads images', () => {
    const html = render('![tracker](https://example.com/pixel.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[image: tracker]')
  })
})
