import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMarkdownImage } from './markdownImage'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

describe('Markdown images', () => {
  it('reads absolute, file URL, and project-relative PNGs as image data', async () => {
    directory = await mkdtemp(join(tmpdir(), 'gloss-images-'))
    const path = join(directory, 'qr code.png')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
    await writeFile(path, Buffer.from(png, 'base64'))
    const expected = `data:image/png;base64,${png}`
    expect(await readMarkdownImage(path)).toBe(expected)
    expect(await readMarkdownImage('qr%20code.png', directory)).toBe(expected)
    const { pathToFileURL } = await import('node:url')
    expect(await readMarkdownImage(pathToFileURL(path).href)).toBe(expected)
  })

  it('rejects remote paths, nonimages, directories, and oversized files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'gloss-images-'))
    for (const src of ['https://example.com/qr.png', 'file://server/share/qr.png', '//server/qr.png', 'data:image/png;base64,test']) {
      await expect(readMarkdownImage(src, directory)).rejects.toThrow('local image path')
    }
    await expect(readMarkdownImage('qr.png')).rejects.toThrow('local image path')
    await expect(readMarkdownImage(directory)).rejects.toThrow()
    const fake = join(directory, 'fake.png')
    await writeFile(fake, '<script>not an image</script>')
    await expect(readMarkdownImage(fake)).rejects.toThrow('Supported image formats')
    await writeFile(fake, Buffer.alloc(20 * 1024 * 1024 + 1))
    await expect(readMarkdownImage(fake)).rejects.toThrow('20 MB')
  })
})
