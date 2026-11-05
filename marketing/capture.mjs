/* global process, console */
// Records the README's and the reel's footage from the built app (run `npm run build` first), with a
// scratch data folder, a throwaway demo project and Haiku. See marketing/README.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launch, openPage, sleep, ROOT } from './lib/app.mjs'
import { DEMO_PAGE, DEMO_PATH, writeDemoProject } from './lib/demo-project.mjs'
import { Human } from './lib/human.mjs'
import { Recorder, gifFrom } from './lib/recorder.mjs'

const MEDIA = join(ROOT, 'marketing', 'media')
const FOOTAGE = join(ROOT, 'marketing', 'footage')
mkdirSync(MEDIA, { recursive: true })
mkdirSync(FOOTAGE, { recursive: true })

// Clips: 1280x800 of layout at a real 1.25x device scale (the screencast ignores an emulated one, so the app
// is launched with it, and a scale of 0 here keeps it). The reel shows them at about their real size.
const DEVICE_SCALE = '1.25'
const CLIP = [1280, 800, 0]
const CLIP_PIXELS = [1600, 1000]
const STILL = [1440, 900, 1.5]
const TURN_TIMEOUT = { timeout: 240000, label: 'the turn to end' }

const IDLE = `document.querySelector('.cancel') === null`

const app = { current: null, win: null, human: null }

const composer = (root = '') => `document.querySelector('${root} .cm-content')`
const menuItem = (label) => `[...document.querySelectorAll('[role=menu] button, [role=menuitem]')].find((b) => b.textContent.includes(${JSON.stringify(label)}))`
const button = (label, root = 'document') => `[...${root}.querySelectorAll('button')].find((b) => (b.title + ' ' + b.getAttribute('aria-label') + ' ' + b.textContent).includes(${JSON.stringify(label)}))`

async function waitForTurn(h, kind = 'main') {
  await h.t.waitFor(`document.querySelector('.cancel') !== null`, { timeout: 15000, label: `the ${kind} turn to start` })
  await h.t.waitFor(IDLE, TURN_TIMEOUT)
}

async function newSession(h) {
  await h.click(`document.querySelector('.new-session')`, { duration: 200 })
  await h.t.waitFor(`document.querySelector('.cm-content') !== null && document.querySelector('.sent-message') === null`)
  await sleep(600)
  // The side panel stays open between sessions; these scenes start without it.
  await h.t.eval(`document.querySelector('.thread-panel .close')?.click()`)
  await sleep(400)
}

/** Sets the current session's title once the agent has had its first prompt, like a user renaming it. */
async function renameCurrent(w, title) {
  await w.eval(`(async () => {
    const sessions = await window.gloss.sessions.list()
    const newest = sessions.toSorted((a, b) => b.createdAt - a.createdAt)[0]
    await window.gloss.sessions.rename(newest.id, ${JSON.stringify(title)})
  })()`)
}

async function sendPrompt(h, text, { delay = 8, root = '' } = {}) {
  await h.click(composer(root), { duration: 300 })
  await h.type(text, { delay })
  await sleep(200)
  await h.enter()
}

async function replyToSelection(h, needle, root) {
  const at = await h.selectText(needle, root)
  await h.clickAt(at.x, at.y, { button: 'right', duration: 200 })
  await sleep(450)
  await h.click(menuItem('Reply to selection'), { duration: 350 })
  await h.t.waitFor(`document.querySelector('.thread-composer .cm-content') !== null`)
  await sleep(450)
}

/** A short phrase from a list item's bold lead, so a selection stays on one line. */
const leadOf = (w, index) => w.eval(`(() => {
  const li = [...document.querySelectorAll('.agent li')][${index}]
  const lead = li.querySelector('strong')?.textContent ?? li.innerText
  const short = lead.replace(/[.:]+$/, '')
  // Whole words, so the highlight doesn't stop inside one.
  return short.length <= 42 ? short : short.slice(0, 43).replace(/\\s+\\S*$/, '')
})()`)

const scenes = {
  /** Reply to one point of a list; the main conversation stays put. */
  async threads(h, w) {
    await sendPrompt(h, "Read this repo and list the 5 biggest problems as a numbered list. Give each a short bold title and one sentence. Don't change anything.", { delay: 1 })
    await waitForTurn(h)
    await renameCurrent(w, 'Biggest problems')
    await w.waitFor(`document.querySelectorAll('.agent li').length >= 5`)
    await w.eval(`document.querySelector('.log-scroll').scrollTop = 0`)
    await sleep(900)

    const third = await leadOf(w, 2)
    const rec = new Recorder(w, CLIP_PIXELS)
    await rec.start()
    await sleep(1200)
    await replyToSelection(h, third, '.agent li')
    rec.mark('panel')
    await h.click(composer('.thread-composer'))
    await h.type('Why does this matter here? Show the smallest fix, in a few lines.')
    await sleep(350)
    await h.enter()
    rec.mark('sent')
    rec.rate(3)
    await waitForTurn(h, 'thread')
    rec.rate(1)
    await sleep(2200)
    await rec.stop()
    // The reel's zoom follows these, and its "one session" scene quotes the same point.
    writeFileSync(join(FOOTAGE, 'reel-data.js'), ['/* global window */', `window.REEL_QUOTE = ${JSON.stringify(third)}`, `window.REEL_MARKS = ${JSON.stringify(rec.markTimes())}`, ''].join('\n'))
    rec.export(join(FOOTAGE, 'threads.mp4'))

    // A second thread off camera, for the overview and the hero shot.
    await replyToSelection(h, await leadOf(w, 0), '.agent li')
    await h.click(composer('.thread-composer'))
    await h.type('Which line would you change first?', { delay: 1 })
    await h.enter()
    await waitForTurn(h, 'thread')
  },

  /** Correct the agent mid-turn, in the same message stream. */
  async steer(h, w) {
    await newSession(h)
    await sleep(300)
    const rec = new Recorder(w, CLIP_PIXELS)
    await rec.start()
    await sleep(500)
    await sendPrompt(h, 'Wire the search box in public/app.js to GET /trails?q=, make matching case-insensitive, then write tests for it.', { delay: 7 })
    await w.waitFor(`document.querySelector('.cancel') !== null`, { timeout: 15000, label: 'the turn to start' })
    await sleep(1400)
    await h.click(composer(), { duration: 280 })
    await h.type('Skip the tests for now, just the search.', { delay: 14 })
    await sleep(250)
    await h.enter()
    await w.waitFor(`document.querySelector('.steered-label') !== null`, { timeout: 10000, label: 'the steered message' })
    await sleep(1100)
    rec.rate(4)
    await w.waitFor(IDLE, TURN_TIMEOUT)
    rec.rate(1)
    await sleep(2200)
    await rec.stop()
    rec.export(join(FOOTAGE, 'steer.mp4'))
    await renameCurrent(w, 'Wire up search')
    await sleep(400)
  },

  /** Pin problems on a screenshot, send it, discuss a pin in its own thread. */
  async pins(h, w, shared) {
    await newSession(h)
    const png = readFileSync(shared.demoShot).toString('base64')
    const parts = []

    // The composer, with the screenshot attached.
    let rec = new Recorder(w, CLIP_PIXELS)
    await rec.start()
    await sleep(600)
    await w.eval(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'trailmap.png', { type: 'image/png' }))
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })()`)
    await w.waitFor(`document.querySelector('.capture-edit') !== null || document.querySelector('.attachment.capture') !== null`)
    await sleep(700)
    const attachment = await h.rect(`document.querySelector('.attachment.capture')`)
    await h.move(attachment.x + attachment.w / 2, attachment.y + attachment.h / 2, { duration: 550 })
    await sleep(350)
    await h.click(`document.querySelector('.capture-edit')`, { duration: 250 })
    await sleep(300)
    await rec.stop()
    parts.push(rec)

    // The annotation canvas: its own window, recorded on its own.
    const a = await app.current.window((url) => /annotate/i.test(url), 15000)
    await a.setSize(...CLIP)
    await a.waitFor(`document.querySelector('[aria-label^="The capture"]') !== null`)
    await sleep(900)
    const ah = new Human(a)
    await ah.showCursor()
    rec = new Recorder(a, CLIP_PIXELS)
    await rec.start()
    await sleep(500)
    await ah.click(`document.querySelector('[aria-label="Show 0 pins"]')`, { duration: 350 })
    await a.waitFor(`document.querySelector('.annotate-pins') !== null`)
    await sleep(350)
    await ah.click(`document.querySelector('[aria-label="Pin"]')`, { duration: 400 })
    const stage = await a.eval(`(() => { const i = document.querySelector('.annotate-body img, .annotate-body canvas'); const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    // Where the demo page's search button and first badge land, as fractions of the screenshot.
    await ah.clickAt(stage.x + stage.w * shared.spots.button.x, stage.y + stage.h * shared.spots.button.y, { duration: 650 })
    await sleep(300)
    await ah.type("Can't read this button", { delay: 20 })
    await sleep(350)
    await ah.clickAt(stage.x + stage.w * shared.spots.badge.x, stage.y + stage.h * shared.spots.badge.y, { duration: 600 })
    await sleep(300)
    await ah.type('Badges hang off the card', { delay: 20 })
    await sleep(600)
    await rec.stop()
    parts.push(rec)
    await ah.click(`document.querySelector('.annotate-foot .primary')`, { duration: 0 })
    a.close()

    // Back in the session: send it, then open a pin's thread.
    await w.waitFor(`document.querySelector('.capture-pins') !== null`, { timeout: 15000, label: 'the pinned attachment' })
    rec = new Recorder(w, CLIP_PIXELS)
    await rec.start()
    await sleep(700)
    await sendPrompt(h, 'Fix these two in public/style.css.', { delay: 14 })
    rec.rate(6)
    await waitForTurn(h)
    rec.rate(1)
    await renameCurrent(w, 'Fix the trail list styles')
    await sleep(900)
    await h.click(`document.querySelector('[aria-label="Reply to pin 2"]')`, { duration: 700 })
    await w.waitFor(`document.querySelector('.thread-composer .cm-content') !== null`)
    await sleep(500)
    await h.click(composer('.thread-composer'), { duration: 300 })
    await h.type('Keep the badge inside the card on phones too.', { delay: 14 })
    await sleep(250)
    await h.enter()
    rec.rate(6)
    await waitForTurn(h, 'thread')
    rec.rate(1)
    await sleep(1800)
    await rec.stop()
    parts.push(rec)
    concat(parts, join(FOOTAGE, 'pins.mp4'))
  },

  /** A review of the branch's changes, for the stills. */
  async review(h, w) {
    await h.click(`document.querySelector('.review-folder-button')`, { duration: 200 })
    await w.waitFor(`document.querySelector('[aria-label="Run review"]') !== null`, { timeout: 20000, label: 'the review' })
    await sleep(1000)
    await h.click(`document.querySelector('[aria-label="Run review"]')`, { duration: 200 })
    await waitForTurn(h, 'review')
    await sleep(1200)
    // Opens the first finding's file and its thread, on its lines.
    await h.click(`document.querySelector('[aria-label="Next open thread"]')`, { duration: 200 })
    await sleep(1500)
    await w.setSize(...STILL)
    await sleep(600)
    await h.place(-40, -40)
    await w.screenshot(join(FOOTAGE, 'review.png'))
    await w.setSize(...CLIP)
  },

  /** The hero, in both themes, and the small stills the reel's montage uses. */
  async stills(h, w) {
    await w.setSize(...STILL)
    await h.place(-40, -40)
    // A review hides the sidebar.
    await w.eval(`document.querySelector('.sidebar-rail .rail-button')?.click()`)
    await sleep(500)
    await h.click(`[...document.querySelectorAll('.session-title')].find((e) => e.textContent.includes('Biggest problems'))`, { duration: 0 })
    await sleep(1500)
    await h.place(-40, -40)

    // The side panel's overview, listing both threads.
    await w.eval(`(() => { const b = ${button('All threads')}; b?.click(); })()`)
    await sleep(500)
    await w.screenshot(join(FOOTAGE, 'overview.png'))

    await w.waitFor(`document.querySelector('.thread-open') !== null`)
    await w.eval(`[...document.querySelectorAll('.thread-open')].at(0).click()`)
    await w.waitFor(`document.querySelector('.thread-composer') !== null`)
    await sleep(800)
    await w.eval(`document.querySelector('.log-scroll').scrollTop = 0`)
    await sleep(500)
    for (const theme of ['dark', 'light']) {
      await w.eval(`window.gloss.settings.update({ global: { theme: '${theme}' } })`)
      await sleep(900)
      await w.screenshot(join(MEDIA, `hero-${theme}.png`))
    }
    await w.eval(`window.gloss.settings.update({ global: { theme: 'dark' } })`)
    await sleep(500)

    await w.eval(`(${button('New session with any agent')})?.click()`)
    await sleep(500)
    await w.screenshot(join(FOOTAGE, 'agents.png'))
    await h.key('Escape', { vk: 27 })
    await w.setSize(...CLIP)
  },

  /**
   * The phone client, for the reel's montage: this run's own bridge, on a port of its own (a real Gloss may be using
   * the default), paired with a phone-sized window here. It listens on the tailnet only and ends with the run.
   * Needs Tailscale with HTTPS certificates. Doesn't depend on the other scenes: `capture.mjs phone` works alone.
   */
  async phone(h, w) {
    if (await w.eval(`document.querySelector('.sent-message') !== null`)) await newSession(h)
    await sendPrompt(h, "Read this repo and list the 5 biggest problems as a numbered list. Give each a short bold title and one sentence. Don't change anything.", { delay: 1 })
    await waitForTurn(h)
    await renameCurrent(w, 'Biggest problems')
    await w.waitFor(`document.querySelectorAll('.agent li').length >= 5`)
    await replyToSelection(h, await leadOf(w, 1), '.agent li')
    await h.click(composer('.thread-composer'))
    await h.type('Why does this matter here? Keep it short.', { delay: 1 })
    await h.enter()
    await waitForTurn(h, 'thread')

    await w.eval(`window.gloss.settings.update({ global: { phoneAccess: true, phonePort: 8497 } })`)
    await w.waitFor(`window.gloss.phone.status().then((s) => { if (s.state === 'error') throw new Error(s.error); return s.state === 'on' })`, { timeout: 60000, label: 'the phone bridge' })
    const { url } = (await w.eval(`window.gloss.phone.pair()`)).pairing

    const dir = mkdtempSync(join(tmpdir(), 'gloss-phone-'))
    const blank = join(dir, 'blank.html')
    writeFileSync(blank, '<!doctype html><title>blank</title>')
    const { page, close } = await openPage(blank, { width: 393, height: 852, scale: 2 })
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true })
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
      await page.send('Page.navigate', { url })
      await page.waitFor(`[...document.querySelectorAll('.m-btn.m-pri')].some((b) => b.textContent.includes('Pair') && !b.disabled)`, { label: 'the pairing page' })
      await page.eval(`[...document.querySelectorAll('.m-btn.m-pri')].find((b) => b.textContent.includes('Pair')).click()`)
      await page.waitFor(`document.querySelector('.m-row') !== null`, { timeout: 20000, label: 'the session list' })
      // The status row's plan usage is the account's own, not the demo's.
      await page.eval(`(() => { const s = document.createElement('style'); s.textContent = '.status-item[title^="Claude "][title*=" limit"] { display: none !important; }'; document.head.appendChild(s) })()`)
      await sleep(800)
      await page.eval(`[...document.querySelectorAll('.m-row')].find((b) => b.textContent.includes('Biggest problems')).click()`)
      await page.waitFor(`document.querySelectorAll('.m-agent li').length >= 5`, { timeout: 20000, label: 'the conversation' })
      await sleep(1000)
      await page.eval(`document.querySelectorAll('.m-agent li')[0].scrollIntoView({ block: 'start' })`)
      await sleep(400)
      await page.eval(`document.querySelectorAll('.m-agent li')[3].click()`)
      await page.waitFor(`document.querySelector('.m-act.m-pri') !== null`, { label: 'the reply bar' })
      await sleep(500)
      await page.screenshot(join(FOOTAGE, 'phone-reply.png'))
      // The thread this scene started on the desktop.
      await page.eval(`document.querySelector('.m-agent .anchor-chip').click()`)
      await page.waitFor(`document.querySelector('.m-agent li .anchor-chip') === null || document.body.innerText.includes('Reply in thread')`, { label: 'the thread' })
      await sleep(1200)
      await page.screenshot(join(FOOTAGE, 'phone-thread.png'))
    } finally {
      await close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Joins a scene's recordings, which share one frame size, into one clip. */
function concat(recordings, file) {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-concat-'))
  const parts = recordings.map((rec, i) => {
    const part = join(dir, `${i}.mp4`)
    rec.export(part)
    return part
  })
  const list = join(dir, 'list.txt')
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
  mkdirSync(dirname(file), { recursive: true })
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', file], { stdio: 'inherit' })
  rmSync(dir, { recursive: true, force: true })
}

/** The demo page's screenshot, and where its two bugs are, as fractions of the image. */
async function demoScreenshot() {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-demo-page-'))
  const html = join(dir, 'page.html')
  writeFileSync(html, DEMO_PAGE)
  const { page, close } = await openPage(html, { width: 900, height: 560, scale: 1.5 })
  const shot = join(dir, 'trailmap.png')
  const spots = await page.eval(`(() => {
    const at = (s, fx = 0.5, fy = 0.5) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: (r.x + r.width * fx) / innerWidth, y: (r.y + r.height * fy) / innerHeight } }
    return { button: at('.search button'), badge: at('li .miles') }
  })()`)
  await page.screenshot(shot)
  await close()
  return { demoShot: shot, spots, dir }
}

/** Removes what the agent wrote about the demo project, and the project. Nothing else. */
function cleanUp() {
  rmSync(dirname(DEMO_PATH), { recursive: true, force: true })
  const transcripts = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', DEMO_PATH.replace(/[^a-zA-Z0-9]/g, '-'))
  if (existsSync(transcripts)) rmSync(transcripts, { recursive: true, force: true })
}

const only = process.argv.slice(2)
const want = (name) => only.length === 0 || only.includes(name)

cleanUp()
writeDemoProject()
const shared = await demoScreenshot()
const gloss = await launch({ settings: { theme: 'dark', reviewWindow: false }, args: [`--force-device-scale-factor=${DEVICE_SCALE}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] })
app.current = gloss
try {
  const w = await gloss.window()
  await w.setSize(...CLIP)
  await w.waitFor(`document.querySelector('.sidebar') !== null`)
  await w.eval(`window.gloss.sessions.create(${JSON.stringify(DEMO_PATH)}, 'claude')`)
  await w.send('Page.reload')
  await w.waitFor(`document.querySelector('.cm-content') !== null`)
  await sleep(1200)
  // The status line's plan usage is the account's own, not the demo's.
  await w.eval(`(() => { const s = document.createElement('style'); s.textContent = '.status-item[title^="Claude "][title*=" limit"] { display: none !important; }'; document.head.appendChild(s) })()`)
  const human = new Human(w)
  await human.showCursor()
  for (const [name, scene] of Object.entries(scenes)) {
    if (!want(name)) continue
    console.log(`Scene: ${name}`)
    await scene(human, w, shared)
  }
} catch (error) {
  console.error(error)
  const w = await gloss.window().catch(() => null)
  await w?.screenshot(join(ROOT, 'docs', 'plans', 'm27', 'failure.png')).catch(() => {})
  process.exitCode = 1
} finally {
  await gloss.quit()
  rmSync(shared.dir, { recursive: true, force: true })
  cleanUp()
}

if (process.exitCode !== 1) {
  for (const clip of ['threads', 'steer', 'pins']) {
    const mp4 = join(FOOTAGE, `${clip}.mp4`)
    if (existsSync(mp4)) gifFrom(mp4, join(MEDIA, `${clip}.gif`))
  }
}
