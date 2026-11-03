// Deterministic content for the benchmark (M25): long code-heavy answers, tool output,
// diffs and synthetic screenshots. Shared by the seed script and the fake agent.
import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'

/** A seeded PRNG (mulberry32), so every run seeds the same data. */
export function random(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min, max) => min + Math.floor(next() * (max - min + 1))
  const pick = (list) => list[Math.floor(next() * list.length)]
  return { next, int, pick }
}

const WORDS = ('the session log renders each message with its markdown tree and keeps threads anchored to list items ' +
  'while the agent streams chunks over the protocol so the renderer patches only what changed in the store ' +
  'database index search query worker handler cache buffer layout scroll paint frame composer sidebar ' +
  'request response update state effect callback reducer selector component hook memo boundary').split(' ')
const IDENTS = ['session', 'message', 'toolCall', 'thread', 'anchor', 'store', 'cache', 'buffer', 'handler', 'result', 'entry', 'options', 'state', 'chunk', 'index', 'layout']
const FILES = ['src/main/sessions.ts', 'src/main/db.ts', 'src/renderer/src/Log.tsx', 'src/renderer/src/Markdown.tsx', 'src/shared/types.ts', 'src/renderer/src/Composer.tsx', 'src/main/sync.ts', 'src/renderer/src/useSession.ts', 'scripts/build.py', 'crates/core/src/lib.rs']

function sentence(r, words = r.int(8, 22)) {
  const out = []
  for (let i = 0; i < words; i++) out.push(r.pick(WORDS))
  if (r.next() < 0.3) out.splice(r.int(1, out.length - 1), 0, '`' + r.pick(IDENTS) + '`')
  const s = out.join(' ')
  return s[0].toUpperCase() + s.slice(1) + '.'
}

function paragraph(r) {
  return Array.from({ length: r.int(2, 5) }, () => sentence(r)).join(' ')
}

function tsCode(r, lines) {
  const out = [`import { ${r.pick(IDENTS)}, ${r.pick(IDENTS)} } from './${r.pick(IDENTS)}'`, '']
  while (out.length < lines) {
    const name = r.pick(IDENTS) + r.int(1, 99)
    out.push(`export function ${name}(${r.pick(IDENTS)}: ${r.pick(['string', 'number', 'Message[]', 'Map<string, Thread>'])}): void {`)
    for (let i = r.int(2, 6); i > 0; i--) {
      out.push(r.pick([
        `  const ${r.pick(IDENTS)} = ${r.pick(IDENTS)}.filter((x) => x.id !== ${r.int(0, 999)})`,
        `  if (!${r.pick(IDENTS)}) return`,
        `  for (const item of ${r.pick(IDENTS)}) ${r.pick(IDENTS)}.set(item.id, item)`,
        `  // ${sentence(r, r.int(4, 9))}`,
        `  await ${r.pick(IDENTS)}.${r.pick(['flush', 'write', 'emit', 'render'])}({ seq: ${r.int(0, 500)}, text: '${r.pick(WORDS)}' })`
      ]))
    }
    out.push('}', '')
  }
  return out.slice(0, lines).join('\n')
}

function pyCode(r, lines) {
  const out = ['import json', 'from pathlib import Path', '']
  while (out.length < lines) {
    out.push(`def ${r.pick(IDENTS).toLowerCase()}_${r.int(1, 99)}(path: Path) -> dict:`)
    for (let i = r.int(2, 5); i > 0; i--) out.push(r.pick([
      `    data = json.loads(path.read_text())`,
      `    # ${sentence(r, r.int(4, 8))}`,
      `    return {k: v for k, v in data.items() if v is not None}`,
      `    for entry in data["${r.pick(IDENTS)}"]:`,
      `        print(entry, ${r.int(0, 99)})`
    ]))
    out.push('')
  }
  return out.slice(0, lines).join('\n')
}

function rustCode(r, lines) {
  const out = ['use std::collections::HashMap;', '']
  while (out.length < lines) {
    out.push(`pub fn ${r.pick(IDENTS).toLowerCase()}_${r.int(1, 99)}(map: &mut HashMap<String, u32>) -> Option<u32> {`)
    for (let i = r.int(2, 5); i > 0; i--) out.push(r.pick([
      `    let value = map.get("${r.pick(IDENTS)}")?;`,
      `    // ${sentence(r, r.int(4, 8))}`,
      `    map.insert("${r.pick(IDENTS)}".to_string(), ${r.int(0, 999)});`,
      `    if *value > ${r.int(0, 99)} { return Some(*value); }`
    ]))
    out.push('    None', '}', '')
  }
  return out.slice(0, lines).join('\n')
}

const LANGS = [['ts', tsCode], ['tsx', tsCode], ['python', pyCode], ['rust', rustCode], ['json', (r, n) => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`${r.pick(IDENTS)}${i}`, r.int(0, 9999)])), null, 2)], ['bash', (r, n) => Array.from({ length: n }, () => `npm run ${r.pick(['build', 'test', 'lint'])} -- --filter ${r.pick(IDENTS)}`).join('\n')]]

export function codeBlock(r, lines = r.int(8, 40)) {
  const [lang, make] = r.pick(LANGS)
  return '```' + lang + '\n' + make(r, lines) + '\n```'
}

/** A long agent answer in markdown: headings, lists (thread anchors) and code blocks, about `chars` long. */
export function answer(r, chars) {
  const parts = []
  let length = 0
  while (length < chars) {
    const kind = r.next()
    let part
    if (kind < 0.12) part = `## ${sentence(r, r.int(2, 5)).slice(0, -1)}`
    else if (kind < 0.42) part = paragraph(r)
    else if (kind < 0.62) part = Array.from({ length: r.int(3, 7) }, () => `- ${sentence(r, r.int(6, 16))}`).join('\n')
    else if (kind < 0.7) part = Array.from({ length: r.int(3, 5) }, (_, i) => `${i + 1}. ${sentence(r, r.int(6, 14))}`).join('\n')
    else part = codeBlock(r)
    parts.push(part)
    length += part.length + 2
  }
  return parts.join('\n\n')
}

/** Lines of a source file, for reads and the two sides of an edit. */
export function sourceLines(r, lines) {
  return tsCode(r, lines).split('\n')
}

/** A tool call's ACP fields: a read, a command or an edit. */
export function toolCall(r, id) {
  const path = r.pick(FILES)
  const kind = r.pick(['read', 'read', 'execute', 'edit', 'edit', 'search'])
  if (kind === 'edit') {
    const old = sourceLines(r, r.int(40, 160))
    const edited = old.slice()
    for (let i = r.int(3, 12); i > 0; i--) {
      const at = r.int(0, edited.length - 1)
      if (r.next() < 0.5) edited.splice(at, 1, `  // ${sentence(r, r.int(4, 8))}`, edited[at])
      else edited.splice(at, r.int(1, 3))
    }
    return { toolCallId: id, title: `Edit ${path}`, kind: 'edit', status: 'completed', content: [{ type: 'diff', path, oldText: old.join('\n'), newText: edited.join('\n') }] }
  }
  if (kind === 'execute') {
    const lines = Array.from({ length: r.int(20, 200) }, (_, i) => `${r.pick(['PASS', 'PASS', 'PASS', 'ok', 'warn'])} ${r.pick(FILES)} (${r.int(1, 900)} ms) ${i}`)
    return { toolCallId: id, title: `\`npm run ${r.pick(['test', 'build', 'lint'])}\``, kind: 'execute', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '```console\n' + lines.join('\n') + '\n```' } }] }
  }
  if (kind === 'search') {
    const lines = Array.from({ length: r.int(5, 40) }, () => `${r.pick(FILES)}:${r.int(1, 900)}: ${r.pick(IDENTS)}`)
    return { toolCallId: id, title: `grep "${r.pick(IDENTS)}"`, kind: 'search', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }] }
  }
  return { toolCallId: id, title: `Read ${path}`, kind: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '```ts\n' + sourceLines(r, r.int(30, 250)).join('\n') + '\n```' } }] }
}

export function userText(r) {
  return Array.from({ length: r.int(1, 3) }, () => sentence(r, r.int(6, 20))).join(' ')
}

// PNG encoding, for synthetic screenshots.
const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buffer) {
  let c = -1
  for (const b of buffer) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * A screenshot-like PNG: panels and lines of "text" (pixel runs), so it compresses
 * like a real one. Returns the PNG without its end chunk: `uniquePng` adds a tag and ends it.
 */
export function screenshot(seed, width, height) {
  const r = random(seed)
  const row = width * 3 + 1
  const raw = Buffer.alloc(row * height)
  const dark = r.next() < 0.5
  const bg = dark ? [30, 31, 36] : [250, 250, 252]
  const panels = Array.from({ length: r.int(3, 6) }, () => {
    const x = r.int(0, width - 200)
    const y = r.int(0, height - 200)
    const shade = dark ? r.int(36, 60) : r.int(225, 245)
    return { x, y, w: r.int(150, Math.max(160, width - x)), h: r.int(120, Math.max(130, height - y)), color: [shade, shade, shade + 4] }
  })
  for (let y = 0; y < height; y++) {
    raw[y * row] = 1 // Sub filter: runs of equal pixels compress, edges don't.
    const textRow = y % 22 > 6 && y % 22 < 17
    let prev = [0, 0, 0]
    let inText = false
    for (let x = 0; x < width; x++) {
      let c = bg
      for (const p of panels) if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) c = p.color
      if (textRow) {
        if (r.next() < 0.08) inText = !inText
        if (inText && r.next() < 0.55) c = dark ? [200 + r.int(0, 40), 200, 210] : [40, 40 + r.int(0, 40), 50]
      }
      const o = y * row + 1 + x * 3
      for (let k = 0; k < 3; k++) raw[o + k] = (c[k] - prev[k]) & 0xff
      prev = c
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 }))])
}

/** The screenshot with a text chunk naming `tag`, so each attachment is a distinct image. */
export function uniquePng(base, tag) {
  return Buffer.concat([base, chunk('tEXt', Buffer.from(`Comment\0${tag}`, 'latin1')), chunk('IEND', Buffer.alloc(0))])
}

/** Sizes of the synthetic screenshots: mixed aspect ratios, as captured on real displays. */
export const SCREENSHOT_SIZES = [[2560, 1440], [1920, 1080], [3440, 1440], [1280, 2400], [900, 1600], [1600, 1000], [800, 600]]
