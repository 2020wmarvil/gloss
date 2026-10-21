import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders lists, code and GFM tables', () => {
    const html = render('1. **One**\n2. `two`\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<ol>')
    // Text runs are wrapped in spans that carry their source offsets.
    expect(html).toMatch(/<strong>(<span[^>]*>)+One(<\/span>)+<\/strong>/)
    expect(html).toMatch(/<code><span[^>]*>two<\/span><\/code>/)
    expect(html).toContain('<table>')
  })

  it('shows raw HTML as text instead of rendering it', () => {
    const html = render('Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<iframe src="https://evil"></iframe>')
    expect(html).not.toMatch(/<img|<script|<iframe/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;iframe')
  })

  it('links web, mail and local files while rejecting unsafe schemes and relative paths', () => {
    const html = render('[web](https://example.com) [mail](mailto:a@b.c) [js](javascript:alert(1)) [rel](src/a.ts) [file](file:///etc/passwd)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('href="mailto:a@b.c"')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href="src/a.ts"')
    expect(html).toContain('href="file:///etc/passwd"')
    expect(html).toContain('target="_blank"')
  })

  it('preserves Windows file links and line numbers through URL sanitization', () => {
    const html = render('[plan](C:/work/MILESTONES.md:146) [prefixed](/C:/work/MILESTONES.md:146) [spaces](<C:/my project/a.md:3>)')
    expect(html).toContain('href="C:/work/MILESTONES.md:146"')
    expect(html).toContain('href="/C:/work/MILESTONES.md:146"')
    expect(html).toContain('href="C:/my%20project/a.md:3"')
    expect(html).not.toContain('target="_blank"')
  })

  it('keeps network and executable-scheme links inert', () => {
    const html = render('[share](file://server/share/a.md) [unc](//server/share/a.md) [data](data:text/html,test) [editor](vscode://file/a.ts)')
    expect(html).not.toContain('<a ')
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
    expect(html).toContain('aria-label="3 replies"')
    expect(html).toContain('class="anchor-item active"')
    // Still a list, with the list's own markers.
    expect(html).toContain('<ol>')
    // The nested item is a plain list item (its text wrapped in source spans).
    expect(html).toMatch(/<li><span><span data-src="\d+" data-src-end="\d+">nested<\/span><\/span><\/li>/)
  })

  it('renders ordinary lists when list item replies are off, keeping selection anchors', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={'1. First\n   - nested\n2. Second\n\n- Third'}
        listItemReplies={false}
        anchors={{
          replyCount: () => 3,
          activeIndex: 0,
          runningIndex: null,
          onOpenItem: () => {},
          marks: [{ start: 3, end: 8, threadId: 'selection-thread' }],
          threadCount: () => 2,
          runningThread: null,
          onOpenThread: () => {}
        }}
      />
    )
    expect(html).toContain('<ol>')
    expect(html).toContain('<ul>')
    expect(html).not.toContain('with-anchors')
    expect(html).not.toContain('anchor-item')
    expect(html).not.toContain('Reply to item')
    expect(html).not.toContain('Open thread on item')
    expect(html).toContain('data-src=')
    expect(html).toContain('aria-label="Open thread, 2 replies"')
  })

  it('never loads images', () => {
    const html = render('![tracker](https://example.com/pixel.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[image: tracker]')
  })
})
