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

  it('adds reply affordances to top-level list items only', () => {
    const md = 'Intro\n\n1. First\n   - nested\n2. Second\n\n- Third\n'
    const html = renderToStaticMarkup(
      <Markdown
        text={md}
        anchors={{
          replyCount: (i) => (i === 1 ? 3 : 0),
          activeIndex: 1,
          runningIndex: null,
          onOpenItem: () => {},
          marks: [],
          threadCount: () => 0,
          runningThread: null,
          onOpenThread: () => {}
        }}
      />
    )
    expect(html.match(/class="anchor-item/g)).toHaveLength(3)
    expect(html).toContain('aria-label="Reply to item 1"')
    expect(html).toContain('aria-label="Open thread on item 2"')
    expect(html).toContain('3 replies')
    expect(html).toContain('class="anchor-item active"')
    expect(html).toContain('<span class="anchor-marker" aria-hidden="true">•</span>')
    // The nested item is a plain list item (its text wrapped in source spans).
    expect(html).toMatch(/<li><span><span data-src="\d+" data-src-end="\d+">nested<\/span><\/span><\/li>/)
  })

  it('never loads images', () => {
    const html = render('![tracker](https://example.com/pixel.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[image: tracker]')
  })
})
