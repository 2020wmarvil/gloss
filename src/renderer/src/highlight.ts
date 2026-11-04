// Syntax highlighting for code blocks (Shiki with its JavaScript regex engine: no
// WebAssembly, so the CSP stays as is). Common languages load at startup, others
// on first use. Highlighting is synchronous once a language is loaded; until then
// code renders plain and subscribers re-render when it arrives. Colors are
// light-dark() pairs, so they follow the theme's color-scheme without a re-render.
import { startTransition, useEffect, useState } from 'react'
import { createHighlighterCore, type GrammarState, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import githubDark from 'shiki/themes/github-dark.mjs'
import githubLight from 'shiki/themes/github-light.mjs'

const THEMES = { light: 'github-light', dark: 'github-dark' }
const PRELOAD = ['typescript', 'tsx', 'javascript', 'jsx', 'json', 'shellscript', 'powershell', 'python', 'css', 'html', 'markdown', 'yaml', 'diff']

let highlighter: HighlighterCore | null = null
/** Bumped whenever the highlighter or a language becomes available. */
let version = 0
const listeners = new Set<() => void>()
const loading = new Set<string>()

function changed(): void {
  version++
  for (const l of listeners) l()
}

const ready = createHighlighterCore({
  themes: [githubLight, githubDark],
  langs: PRELOAD.map((id) => bundledLanguages[id as keyof typeof bundledLanguages]),
  engine: createJavaScriptRegexEngine({ forgiving: true })
}).then(
  (h) => {
    highlighter = h
    changed()
  },
  (err: unknown) => console.error('[gloss] highlighter failed to load:', err)
)

/**
 * Re-renders the caller when highlighting becomes available for more code. As a transition:
 * coloring every code block in view at once took one long task, which held up the first
 * paint; React renders a transition in slices and paints in between (SPEC → Performance).
 */
export function useHighlighting(): number {
  const [seen, setSeen] = useState(version)
  useEffect(() => {
    const update = (): void => startTransition(() => setSeen(version))
    listeners.add(update)
    // It may have changed between the render and this effect.
    update()
    return () => {
      listeners.delete(update)
    }
  }, [])
  return seen
}

/** The language's id once it is loaded; null until then (starting to load it). */
function loaded(lang: string | null | undefined): string | null {
  if (!lang || !highlighter) return null
  const id = lang.toLowerCase()
  if (highlighter.getLoadedLanguages().includes(id)) return id
  const load = bundledLanguages[id as keyof typeof bundledLanguages]
  if (load && !loading.has(id)) {
    loading.add(id)
    void ready
      .then(() => highlighter?.loadLanguage(load))
      .then(changed, (err: unknown) => console.warn(`[gloss] could not load language ${id}:`, err))
  }
  return null
}

type Colors = (string | undefined)[]

/** Colors a piece of code's tokens into `colors`, from `offset`; the grammar state after it. */
function tokenize(code: string, id: string, colors: Colors, offset: number, state?: GrammarState): GrammarState | undefined {
  const result = highlighter!.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: 'light-dark()', ...(state ? { grammarState: state } : {}) })
  for (const line of result.tokens) {
    for (const token of line) {
      // With two themes the color is only in htmlStyle, as "light-dark(light, dark)".
      const color = token.htmlStyle?.color
      for (let i = 0; i < token.content.length; i++) colors[offset + token.offset + i] = color
    }
  }
  return result.grammarState
}

/** One character color per character of `code` (undefined = default), or null if the language isn't available (yet). */
export function codeColors(code: string, lang: string | null | undefined): Colors | null {
  const id = loaded(lang)
  if (!id) return null
  const key = `${id}\0${code}`
  const cached = cache.get(key)
  if (cached) return cached
  const colors = new Array<string | undefined>(code.length)
  try {
    tokenize(code, id, colors, 0)
  } catch {
    return null
  }
  remember(key, colors)
  return colors
}

/** Colors already worked out for `code`, without working them out; undefined if there are none. */
export function cachedColors(code: string, lang: string | null | undefined): Colors | undefined {
  return lang ? cache.get(`${lang.toLowerCase()}\0${code}`) : undefined
}

const cache = new Map<string, Colors>()

function remember(key: string, colors: Colors): void {
  if (cache.size > 300) cache.delete(cache.keys().next().value as string)
  cache.set(key, colors)
}

/** Lines tokenized at a time in the background. */
const SLICE_LINES = 20
/** Background work per task before yielding to the renderer, ms. */
const BUDGET_MS = 8

type Job = { id: string; key: string; lines: string[]; at: number; offset: number; state?: GrammarState; colors: Colors; done(colors: Colors | null): void }
const queue: Job[] = []
let scheduled = false

/**
 * Colors `code` like codeColors, but in the background: a few lines at a time, carrying
 * the grammar's state between them, in tasks short enough that the renderer stays
 * responsive however long the code (SPEC → Performance). Calls `done` with the colors,
 * at once when they are known or the language isn't available (null; it starts to
 * load, and useHighlighting re-renders when it has). Returns a function that cancels it.
 */
export function colorsInBackground(code: string, lang: string | null | undefined, done: (colors: Colors | null) => void): () => void {
  const id = loaded(lang)
  const cached = id ? cache.get(`${id}\0${code}`) : undefined
  if (!id || cached) {
    done(cached ?? null)
    return () => {}
  }
  const job: Job = { id, key: `${id}\0${code}`, lines: code.split('\n'), at: 0, offset: 0, colors: new Array<string | undefined>(code.length), done }
  queue.push(job)
  schedule()
  return () => {
    const i = queue.indexOf(job)
    if (i >= 0) queue.splice(i, 1)
  }
}

function schedule(): void {
  if (scheduled || queue.length === 0) return
  scheduled = true
  setTimeout(work, 0)
}

function work(): void {
  scheduled = false
  const end = performance.now() + BUDGET_MS
  while (queue.length > 0 && performance.now() < end) {
    const job = queue[0]
    const slice = job.lines.slice(job.at, job.at + SLICE_LINES).join('\n')
    try {
      job.state = tokenize(slice, job.id, job.colors, job.offset, job.state)
    } catch {
      queue.shift()
      job.done(null)
      continue
    }
    job.at += SLICE_LINES
    job.offset += slice.length + 1
    if (job.at >= job.lines.length) {
      queue.shift()
      remember(job.key, job.colors)
      job.done(job.colors)
    }
  }
  schedule()
}
