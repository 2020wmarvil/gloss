/* global document, window */
/* The timeline. Times are seconds. A clip scene plays its footage frame for frame, from `from` seconds in to its
   end, so it takes as long as its clip (a fractional speed judders). Only one caption ever shows. */
const SCENES = [
  // The first frame is the still GitHub's player shows before anyone presses play, so it starts complete.
  { id: 'intro', length: 3, still: true },
  {
    id: 'threads', clip: 'threads', from: 0.6,
    caption: "Reply to any point in your agent's answer."
  },
  { id: 'linear', length: 5, caption: "To the agent, it's still one session." },
  { id: 'steer', clip: 'steer', from: 0.9, caption: "Steer a turn while it's running." },
  { id: 'pins', clip: 'pins', from: 1.4, caption: "Point at what's wrong, then discuss each pin." },
  { id: 'review', length: 2.8, caption: 'Review a diff, with threads on its lines.' },
  { id: 'phone', length: 3, caption: 'Drive your sessions from your phone.' },
  { id: 'overview', length: 2.5, caption: 'See every thread at a glance.' },
  { id: 'agents', length: 3, caption: 'Bring your agent: Claude Code, Codex, OpenCode or any ACP agent.' },
  { id: 'outro', length: 4.4 }
]
// A scene dips through the background: the last one is gone before the next appears, so nothing ever overlaps.
const FADE_OUT = 0.22
const FADE_IN = 0.3

/* Lays out the timeline once the clips' lengths are known. Returns the reel's length. */
window.layoutReel = function (clips) {
  window.REEL_CLIPS = clips
  let at = 0
  for (const s of SCENES) {
    s.el = document.getElementById(s.id)
    s.img = s.el.querySelector('.clip')
    if (s.clip) s.length = clips[s.clip].frames / clips[s.clip].fps - s.from
    s.start = at
    at += s.length
  }
  // The threads clip zooms to the panel when it opens, and up to the answer once the reply is sent.
  const threads = SCENES.find((s) => s.id === 'threads')
  const panel = window.REEL_MARKS.panel - threads.from
  const sent = window.REEL_MARKS.sent - threads.from
  threads.zoom = [[0, 1, 1, 1], [panel - 0.5, 1, 1, 1], [panel + 0.3, 1.25, 1, 1], [sent, 1.25, 1, 1], [sent + 0.8, 1.25, 1, 0.1], [threads.length, 1.25, 1, 0.1]]
  return at
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const ease = (v) => { const k = clamp(v); return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2 }
const span = (t, a, b) => ease((t - a) / (b - a))

document.getElementById('wireTag').textContent = `[re: "${window.REEL_QUOTE}"]`

const DRAW = {
  linear(t) {
    const row = document.getElementById('wireThread')
    row.style.opacity = span(t, 0.3, 0.9)
    row.style.transform = `translateX(${(1 - span(t, 0.3, 0.9)) * 60}px)`
    this.el.querySelectorAll('.wire-row')[2].style.opacity = span(t, 1.1, 1.7)
    this.el.querySelector('.note').style.opacity = span(t, 1.9, 2.5)
  },
  outro(t) {
    this.el.querySelector('.lockup').style.transform = `scale(${0.96 + 0.04 * span(t, 0, 0.8)})`
    this.el.querySelector('.sub').style.opacity = span(t, 0.5, 1.1)
    this.el.querySelector('.url').style.opacity = span(t, 1, 1.6)
    this.el.querySelector('.platforms').style.opacity = span(t, 1.3, 1.9)
  }
}

/* A clip's zoom keyframes: [time, scale, focus x, focus y], the focus as a fraction of the room left over. */
function zoomAt(keys, t) {
  let i = 0
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++
  const [a, b] = [keys[i], keys[i + 1]]
  const k = span(t, a[0], b[0])
  const mix = (n) => a[n] + (b[n] - a[n]) * k
  const scale = mix(1)
  return `translate(${-(scale - 1) * 1456 * mix(2)}px, ${-(scale - 1) * 910 * mix(3)}px) scale(${scale})`
}

const caption = document.getElementById('caption')
function drawCaption(s, local) {
  caption.textContent = s.caption ?? ''
  caption.style.opacity = span(local, 0, FADE_IN) * (1 - span(local, s.length - FADE_OUT, s.length))
  caption.style.transform = `translateY(${(1 - span(local, 0, FADE_IN)) * 8}px)`
}

/* Draws the frame at time t, once its images are decoded. */
window.seek = async function (t) {
  const waits = []
  for (const s of SCENES) {
    const local = t - s.start
    const visible = local >= 0 && local < s.length
    s.el.classList.toggle('on', visible)
    if (!visible) continue
    s.el.style.opacity = (s.still ? 1 : span(local, 0, FADE_IN)) * (1 - span(local, s.length - FADE_OUT, s.length))
    drawCaption(s, local)
    DRAW[s.id]?.call(s, local)
    if (s.img) {
      const info = window.REEL_CLIPS[s.clip]
      const frame = Math.min(info.frames, 1 + Math.round((s.from + local) * info.fps))
      const src = `${info.dir}/${String(frame).padStart(5, '0')}.jpg`
      if (s.img.dataset.src !== src) {
        s.img.dataset.src = src
        s.img.src = src
        waits.push(s.img.decode().catch(() => {}))
      }
      if (s.zoom) s.img.style.transform = zoomAt(s.zoom, local)
    }
  }
  await Promise.all(waits)
  return true
}
