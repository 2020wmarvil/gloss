// Keyboard shortcuts as Electron accelerators ("Ctrl+Shift+Alt+S"), for the capture shortcut
// (SPEC → Visual feedback): read from a key press, checked when typed into settings.json, and
// shown as keys. Pure, no DOM or Node imports.

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const
type Modifier = (typeof MODIFIERS)[number]

/** Names Electron accepts for each modifier, lowercased, to the one Gloss writes. */
const MODIFIER_NAMES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  command: 'Super',
  cmd: 'Super'
}

/** KeyboardEvent.code → Electron's key name, for the keys a shortcut may end in. */
const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/** Keys that make a shortcut alone, without Ctrl, Alt or the Windows/Command key. */
const STANDALONE = /^(F([1-9]|1\d|2[0-4])|PrintScreen)$/

/** Electron's name for the key of `code`, or null for keys a shortcut can't end in. */
function keyOf(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^Digit(\d)$/.exec(code)
  if (m) return m[1]
  m = /^Numpad(\d)$/.exec(code)
  if (m) return `num${m[1]}`
  m = /^F([1-9]|1\d|2[0-4])$/.exec(code)
  if (m) return code
  return CODE_KEYS[code] ?? null
}

const KEY_NAMES = new Map<string, string>()
for (const name of [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `num${i}`),
  ...Object.values(CODE_KEYS),
  'Plus',
  'Return',
  'Esc',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right'
]) {
  KEY_NAMES.set(name.toLowerCase(), name === 'Return' ? 'Enter' : name)
}

export type KeyPress = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/** The modifiers held, in the order Gloss writes them. */
export function heldModifiers(e: KeyPress): Modifier[] {
  return MODIFIERS.filter((m) => (m === 'Ctrl' ? e.ctrlKey : m === 'Alt' ? e.altKey : m === 'Shift' ? e.shiftKey : e.metaKey))
}

/**
 * The shortcut a key press makes: an accelerator, `null` while only modifiers are held, or an
 * explanation when the key can't make one (a plain letter would stop typing it everywhere).
 */
export function shortcutFromKey(e: KeyPress): { accelerator: string } | { error: string } | null {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return null
  const key = keyOf(e.code)
  if (!key) return { error: "That key can't be used." }
  const mods = heldModifiers(e)
  if (!STANDALONE.test(key) && !mods.some((m) => m !== 'Shift')) {
    return { error: 'Add Ctrl, Alt or Win.' }
  }
  return { accelerator: [...mods, key].join('+') }
}

/**
 * The accelerator written the way Gloss writes it ("ctrl + shift + s" → "Ctrl+Shift+S"), or null
 * if it isn't a shortcut: one key, after any modifiers, and Ctrl, Alt or Super unless the key
 * stands alone (F1–F24, PrintScreen).
 */
export function normalizeShortcut(value: string): string | null {
  const parts = value
    .split('+')
    .map((p) => p.trim())
    // "Ctrl++" and "Ctrl+Plus" both mean the + key.
    .map((p, i, all) => (p === '' && i === all.length - 1 && all.length > 1 ? 'Plus' : p))
    .filter((p) => p !== '')
  if (parts.length === 0) return null
  const key = KEY_NAMES.get(parts[parts.length - 1].toLowerCase())
  if (!key || key === 'Esc' || key === 'Escape') return null
  const mods = new Set<Modifier>()
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIER_NAMES[p.toLowerCase()]
    if (!m) return null
    mods.add(m)
  }
  if (!STANDALONE.test(key) && ![...mods].some((m) => m !== 'Shift')) return null
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+')
}

/** The keys of an accelerator as shown on keycaps: "Win" (or "Cmd" on macOS) for Super, "PrtSc". */
export function shortcutKeys(accelerator: string, mac = false): string[] {
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((k) => (k === 'Super' ? (mac ? 'Cmd' : 'Win') : k === 'PrintScreen' ? 'PrtSc' : k === 'Plus' ? '+' : k))
}

/** An accelerator for a tooltip: "Ctrl+Shift+Alt+S". */
export function shortcutLabel(accelerator: string, mac = false): string {
  return shortcutKeys(accelerator, mac).join('+')
}
