/* global Buffer, console */
// Records a window over CDP and turns it into an MP4. A section can be sped up, so a wait
// on the agent doesn't take its real time in the clip.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export class Recorder {
  /** `size`: the frame size in device pixels. */
  constructor(target, size) {
    this.t = target
    this.size = size
    this.frames = []
    this.dir = mkdtempSync(join(tmpdir(), 'gloss-frames-'))
    this.rates = []
    this.marks = {}
  }

  /** The screencast gives 70 frames a second, against about 13 for a loop of screenshots. */
  async start() {
    let writes = Promise.resolve()
    this.stopListening = this.t.on('Page.screencastFrame', (f) => {
      void this.t.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
      const file = join(this.dir, `${String(this.frames.length).padStart(6, '0')}.jpg`)
      this.frames.push({ file, at: f.metadata.timestamp })
      writes = writes.then(() => writeFile(file, Buffer.from(f.data, 'base64')))
    })
    this.flush = () => writes
    this.rate(1)
    await this.t.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: this.size[0], maxHeight: this.size[1] })
  }

  /** Remembers where the clip is now, to time the reel's zoom. */
  mark(name) {
    this.marks[name] = Date.now() / 1000
  }

  markTimes() {
    return Object.fromEntries(Object.entries(this.marks).map(([name, at]) => [name, Number(this.clipTime(at).toFixed(3))]))
  }

  /** From now on the clip plays at `speed` times real time. */
  rate(speed) {
    this.rates.push({ at: Date.now() / 1000, speed })
  }

  async stop() {
    this.end = Date.now() / 1000
    await this.t.send('Page.stopScreencast')
    this.stopListening()
    await this.flush()
    const gaps = this.frames.slice(1).map((f, i) => (f.at - this.frames[i].at) * 1000).sort((a, b) => a - b)
    console.log(`  ${this.frames.length} frames over ${(this.end - this.rates[0].at).toFixed(1)} s; gap between frames: median ${gaps[gaps.length >> 1]?.toFixed(0)} ms, 90th percentile ${gaps[Math.floor(gaps.length * 0.9)]?.toFixed(0)} ms`)
    return this
  }

  /** Clip time of an instant, applying the speed changes. */
  clipTime(at) {
    let time = 0
    for (let i = 0; i < this.rates.length; i++) {
      const from = this.rates[i].at
      const to = Math.min(at, this.rates[i + 1]?.at ?? Infinity)
      if (to > from) time += (to - from) / this.rates[i].speed
    }
    return time
  }

  /** Writes the MP4 and removes the frames. */
  export(file, { fps = 60 } = {}) {
    if (this.frames.length === 0) throw new Error(`No frames recorded for ${file}`)
    mkdirSync(dirname(file), { recursive: true })
    const lines = []
    let previous = 0
    this.frames.forEach((frame, i) => {
      const next = this.frames[i + 1]?.at ?? this.end
      const time = this.clipTime(next)
      const duration = Math.max(time - previous, 0.001)
      previous = time
      lines.push(`file '${frame.file.replace(/\\/g, '/')}'`, `duration ${duration.toFixed(4)}`)
    })
    lines.push(`file '${this.frames.at(-1).file.replace(/\\/g, '/')}'`)
    const list = join(this.dir, 'list.txt')
    writeFileSync(list, lines.join('\n'))
    const scale = `scale=${this.size[0]}:${this.size[1]}:flags=lanczos,`
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `${scale}fps=${fps},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', file], { stdio: 'inherit' })
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** A GIF from a clip, with a palette per clip. */
export function gifFrom(mp4, gif, { fps = 15, width = 1000, colors = 192 } = {}) {
  const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-filter_complex', filter, gif], { stdio: 'inherit' })
}
