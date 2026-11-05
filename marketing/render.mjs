/* global process, console, Buffer */
// Renders the reel (reel/index.html) to media/gloss-demo.mp4 and the social preview (social/index.html) to
// media/social-preview.png. `node marketing/render.mjs stills 5 20 41` writes frames for a quick look.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openPage, ROOT } from './lib/app.mjs'

const MARKETING = join(ROOT, 'marketing')
const MEDIA = join(MARKETING, 'media')
const FPS = 60
const CLIPS = ['threads', 'steer', 'pins']

/** The footage as numbered JPEGs, which the page can show frame-exactly. */
function extractFrames(dir) {
  const clips = {}
  for (const clip of CLIPS) {
    const out = join(dir, clip)
    mkdirSync(out)
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(MARKETING, 'footage', `${clip}.mp4`), '-vf', `fps=${FPS}`, '-q:v', '2', join(out, '%05d.jpg')], { stdio: 'inherit' })
    clips[clip] = { dir: pathToFileURL(out).href, frames: readdirSync(out).length, fps: FPS }
  }
  return clips
}

async function openReel(dir) {
  const clips = extractFrames(dir)
  const reel = await openPage(join(MARKETING, 'reel', 'index.html'), { width: 1920, height: 1080 })
  reel.length = await reel.page.eval(`window.layoutReel(${JSON.stringify(clips)})`)
  return reel
}

async function frame(page) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } })
  return Buffer.from(data, 'base64')
}

async function renderReel() {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-reel-'))
  const { page, close, length } = await openReel(dir)
  const count = Math.ceil(length * FPS)
  // Moved into place when finished, so an interrupted render never leaves a broken video.
  const partial = join(dir, 'gloss-demo.mp4')
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-i', join(MARKETING, 'reel', 'music.m4a'), '-map', '0:v', '-map', '1:a', '-af', `afade=t=in:d=0.4,afade=t=out:st=${(length - 3).toFixed(2)}:d=3`, '-t', length.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', partial], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((ok, fail) => ffmpeg.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`)))))
  for (let i = 0; i < count; i++) {
    await page.eval(`seek(${i / FPS})`)
    const png = await frame(page)
    if (!ffmpeg.stdin.write(png)) await new Promise((ok) => ffmpeg.stdin.once('drain', ok))
    if (i % 600 === 0) console.log(`${(i / FPS).toFixed(0)} s of ${length.toFixed(0)} s`)
  }
  ffmpeg.stdin.end()
  await done
  await close()
  copyFileSync(partial, join(MEDIA, 'gloss-demo.mp4'))
  rmSync(dir, { recursive: true, force: true })
  console.log(`Reel: ${length.toFixed(1)} s`)
}

async function renderStills(times) {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-reel-'))
  const { page, close, length } = await openReel(dir)
  const out = join(ROOT, 'docs', 'plans', 'm27')
  mkdirSync(out, { recursive: true })
  for (const t of times) {
    await page.eval(`seek(${t})`)
    await page.screenshot(join(out, `reel-${String(t).padStart(5, '0')}.png`))
  }
  console.log(`Length: ${length.toFixed(1)} s`)
  await close()
  rmSync(dir, { recursive: true, force: true })
}

async function renderSocial() {
  const { page, close } = await openPage(join(MARKETING, 'social', 'index.html'), { width: 1280, height: 640 })
  await page.screenshot(join(MEDIA, 'social-preview.png'))
  await close()
}

const [what = 'all', ...rest] = process.argv.slice(2)
if (what === 'stills') await renderStills(rest.map(Number))
if (what === 'social' || what === 'all') await renderSocial()
if (what === 'reel' || what === 'all') await renderReel()
