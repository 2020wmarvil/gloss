// Syntax highlighting for code blocks (Shiki with its JavaScript regex engine: no
// WebAssembly, so the CSP stays as is). Common languages load at startup, others
// on first use. Colors are light-dark() pairs, so they follow the system theme.
// Highlighting is synchronous once a language is loaded; until then
// code renders plain and subscribers re-render when it arrives.
import { useSyncExternalStore } from 'react'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
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

/** Re-renders the caller when highlighting becomes available for more code. */
export function useHighlighting(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
    () => version
  )
}

/** One character color per character of `code` (undefined = default), or null if the language isn't available (yet). */
export function codeColors(code: string, lang: string | null | undefined): (string | undefined)[] | null {
  if (!lang || !highlighter) return null
  const id = lang.toLowerCase()
  if (!highlighter.getLoadedLanguages().includes(id)) {
    const load = bundledLanguages[id as keyof typeof bundledLanguages]
    if (load && !loading.has(id)) {
      loading.add(id)
      void ready
        .then(() => highlighter?.loadLanguage(load))
        .then(changed, (err: unknown) => console.warn(`[gloss] could not load language ${id}:`, err))
    }
    return null
  }
  const key = `${id}\0${code}`
  const cached = cache.get(key)
  if (cached) return cached
  const colors = new Array<string | undefined>(code.length)
  try {
    const { tokens } = highlighter.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: 'light-dark()' })
    for (const line of tokens) {
      for (const token of line) {
        for (let i = 0; i < token.content.length; i++) colors[token.offset + i] = token.color
      }
    }
  } catch {
    return null
  }
  if (cache.size > 300) cache.delete(cache.keys().next().value as string)
  cache.set(key, colors)
  return colors
}

const cache = new Map<string, (string | undefined)[]>()
