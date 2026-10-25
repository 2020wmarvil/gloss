import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { imageLink } from '../shared/imageLink'

const MAX_BYTES = 20 * 1024 * 1024

/** Return only recognized raster images, never arbitrary file contents or remote URLs. */
export async function readMarkdownImage(src: string, cwd?: string): Promise<string> {
  const path = imageLink(src)
  if (!path || (!isAbsolute(path) && (!cwd || !isAbsolute(cwd)))) throw new Error('Expected a local image path.')
  const file = await open(isAbsolute(path) ? path : resolve(cwd!, path), 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('This path is not a file.')
    if (stat.size > MAX_BYTES) throw new Error('Image exceeds the 20 MB limit.')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('Image exceeds the 20 MB limit.')
    const data = bytes.subarray(0, length)
    const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii')) ? 'image/gif'
      : data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp'
      : null
    if (!mime) throw new Error('Supported image formats: PNG, JPEG, GIF, and WebP.')
    return `data:${mime};base64,${data.toString('base64')}`
  } finally {
    await file.close()
  }
}
