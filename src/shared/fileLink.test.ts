import { describe, expect, it } from 'vitest'
import { fileLink, isMediaFile } from './fileLink'

describe('media files', () => {
  it.each(['C:/a/shot.PNG', '/tmp/clip.mp4', '/tmp/song.flac', '/tmp/x.jpeg'])('treats %s as media', (path) => {
    expect(isMediaFile(path)).toBe(true)
  })

  it.each(['/tmp/icon.svg', '/tmp/a.ts', '/tmp/run.exe', '/tmp/png', '/tmp/a.png.lnk'])('leaves %s to the editor', (path) => {
    expect(isMediaFile(path)).toBe(false)
  })
})

describe('local file links', () => {
  it.each([
    ['C:/work/notes.md:146', 'C:/work/notes.md', 146],
    ['/C:/work/notes.md:146', 'C:/work/notes.md', 146],
    ['C:\\work\\notes.md:12:4', 'C:\\work\\notes.md', 12],
    ['/home/me/a%20b.ts#L8', '/home/me/a b.ts', 8],
    ['file:///C:/work/a%20b.md:7', 'C:/work/a b.md', 7],
    ['file:///home/me/notes.md', '/home/me/notes.md', 1],
    ['/home/me/notes.md', '/home/me/notes.md', 1]
  ])('parses %s', (href, path, line) => {
    expect(fileLink(href)).toEqual({ path, line })
  })

  it.each([
    'https://example.com/a.md', 'mailto:a@b.c', 'javascript:alert(1)', 'data:text/html,test',
    'src/a.ts', 'C:relative.md', '//server/share/a.md', '\\\\server\\share\\a.md',
    'file://server/share/a.md', 'file:////server/share/a.md', '/%5Cserver/share/a.md',
    '/tmp/a%00.md', '/tmp/a%0A.md', '/tmp/bad%escape.md', '/tmp/a.md:999999999999999999999'
  ])('rejects %s', (href) => {
    expect(fileLink(href)).toBeNull()
  })
})
