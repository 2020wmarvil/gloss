// Renders build/icon.svg (and build/icon-small.svg for 32 px and under) to the app icon files:
// build/icon.ico (Windows), build/icon.icns (macOS), build/icon.png and build/icons/<n>x<n>.png (Linux).
// Usage: npm run icons
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { app, BrowserWindow } from 'electron'

const dir = join(import.meta.dirname, '..', 'build')
const svg = (name) => 'data:image/svg+xml;base64,' + readFileSync(join(dir, name)).toString('base64')
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

// Chromium rasterizes an SVG image at the size it is drawn, so each size is drawn from the vector.
async function render() {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  const jobs = sizes.map((size) => ({ size, src: svg(size <= 32 ? 'icon-small.svg' : 'icon.svg') }))
  const urls = await win.webContents.executeJavaScript(`Promise.all(${JSON.stringify(jobs)}.map(({ size, src }) =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        canvas.getContext('2d').drawImage(img, 0, 0, size, size)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = reject
      img.src = src
    })))`)
  win.destroy()
  return new Map(sizes.map((size, i) => [size, Buffer.from(urls[i].split(',')[1], 'base64')]))
}

// ICO with PNG entries (Windows Vista and later). A width or height of 0 means 256.
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const [size, png] of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map(([, png]) => png)])
}

// ICNS with PNG entries: each is a 4-byte type, a 4-byte big-endian length (header included), then the PNG.
function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

app.whenReady().then(async () => {
  try {
    const png = await render()
    writeFileSync(join(dir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, png.get(s)])))
    const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
      ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
    writeFileSync(join(dir, 'icon.icns'), icns(types.map(([t, s]) => [t, png.get(s)])))
    writeFileSync(join(dir, 'icon.png'), png.get(1024))
    mkdirSync(join(dir, 'icons'), { recursive: true })
    for (const s of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(join(dir, 'icons', `${s}x${s}.png`), png.get(s))
    console.log('Wrote build/icon.ico, build/icon.icns, build/icon.png and build/icons/')
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
