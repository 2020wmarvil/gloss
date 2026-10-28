// Renders build/icon.svg (and build/icon-small.svg for 32 px and under) to the app icon files:
// build/icon.ico (Windows), build/icon.icns (macOS), build/icon.png and build/icons/<n>x<n>.png (Linux),
// and the phone client's icons in src/renderer/public (docs/BRAND.md → Phone icon).
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
async function render(win) {
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
  return new Map(sizes.map((size, i) => [size, Buffer.from(urls[i].split(',')[1], 'base64')]))
}

// The phone's icons: the bead on an opaque sunset-tint square. iOS fills a Home Screen icon's
// transparency with black and rounds the corners itself. The bead fills 84% of the side; Android's maskable
// icon (cropped to a circle or squircle) keeps it at 76%, inside the safe zone.
const PHONE = [['apple-touch-icon.png', 180, 0.84], ['icon-192.png', 192, 0.84], ['icon-512.png', 512, 0.84], ['icon-maskable-512.png', 512, 0.76]]

async function renderPhone(win) {
  const urls = await win.webContents.executeJavaScript(`Promise.all(${JSON.stringify(PHONE.map(([, size, scale]) => [size, scale]))}.map(([size, scale]) =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        const ctx = canvas.getContext('2d')
        // CSS linear-gradient(160deg, #fff3f8, #fff4ea) across the square.
        const dx = Math.sin(160 * Math.PI / 180) * size / 2, dy = -Math.cos(160 * Math.PI / 180) * size / 2
        const fill = ctx.createLinearGradient(size / 2 - dx, size / 2 - dy, size / 2 + dx, size / 2 + dy)
        fill.addColorStop(0, '#fff3f8')
        fill.addColorStop(1, '#fff4ea')
        ctx.fillStyle = fill
        ctx.fillRect(0, 0, size, size)
        const bead = Math.round(size * scale)
        ctx.drawImage(img, (size - bead) / 2, (size - bead) / 2, bead, bead)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = reject
      img.src = ${JSON.stringify(svg('icon.svg'))}
    })))`)
  return PHONE.map(([name], i) => [name, Buffer.from(urls[i].split(',')[1], 'base64')])
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
    // One window for both renders: closing the last window would quit the app.
    const win = new BrowserWindow({ show: false })
    await win.loadURL('about:blank')
    const png = await render(win)
    writeFileSync(join(dir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, png.get(s)])))
    const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
      ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
    writeFileSync(join(dir, 'icon.icns'), icns(types.map(([t, s]) => [t, png.get(s)])))
    writeFileSync(join(dir, 'icon.png'), png.get(1024))
    mkdirSync(join(dir, 'icons'), { recursive: true })
    for (const s of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(join(dir, 'icons', `${s}x${s}.png`), png.get(s))
    const phone = join(dir, '..', 'src', 'renderer', 'public')
    for (const [name, data] of await renderPhone(win)) writeFileSync(join(phone, name), data)
    win.destroy()
    console.log('Wrote build/icon.ico, build/icon.icns, build/icon.png, build/icons/ and the phone icons in src/renderer/public/')
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.quit()
})
