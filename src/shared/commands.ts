// Shared command registry. Scope describes the focus context in which a command runs.
export type Command = { id: string; scope: string; keys: string; label: string; legacyKeys?: string[]; editable?: boolean }
export const COMMANDS: readonly Command[] = [
  {"id": "search", "editable": true, "scope": "Anywhere", "keys": "Mod+Shift+F", "label": "Search conversations"},
  {"id": "newSession", "editable": true, "scope": "Anywhere", "keys": "Mod+N", "label": "New session"},
  {"id": "closeSession", "scope": "Anywhere", "keys": "Mod+W", "label": "Close the current session view"},
  {"id": "review", "editable": true, "scope": "Anywhere", "keys": "Mod+Shift+D", "label": "Open or leave branch review"},
  {"id": "nextSession", "editable": true, "scope": "Anywhere", "keys": "Mod+Tab", "label": "Next session"},
  {"id": "previousSession", "editable": true, "scope": "Anywhere", "keys": "Mod+Shift+Tab", "label": "Previous session"},
  {"id": "folder", "editable": true, "scope": "Anywhere", "keys": "Mod+Alt+E", "label": "Open session folder"},
  {"id": "branch", "editable": true, "scope": "Anywhere", "keys": "Mod+Alt+B", "label": "Open branch on GitHub"},
  {"id": "pullRequest", "editable": true, "scope": "Anywhere", "keys": "Mod+Alt+P", "label": "Open pull request on GitHub"},
  {"id": "obsidian", "editable": true, "scope": "Anywhere", "keys": "Mod+Alt+O", "label": "Open Obsidian vault"},
  {"id": "focusComposer", "editable": true, "scope": "Anywhere", "keys": "Mod+L", "label": "Focus composer"},
  {"id": "sidePanel", "editable": true, "scope": "Anywhere", "keys": "Mod+Shift+T", "label": "Show or hide side panel"},
  {"id": "jumpToWork", "editable": true, "scope": "Anywhere", "keys": "Mod+J", "label": "Go to where the agent is working"},
  {"id": "queue", "editable": true, "scope": "Anywhere", "keys": "Mod+Shift+Q", "label": "Show queue"},
  {"id": "popOut", "editable": true, "scope": "Anywhere", "keys": "Mod+Shift+O", "label": "Pop session out or back in"},
  {"id": "capture", "editable": true, "scope": "Anywhere", "keys": "Ctrl+Shift+PrintScreen", "label": "Capture part of the screen"},
  {"id": "settings", "editable": true, "scope": "Anywhere", "keys": "Mod+,", "label": "Open or close settings"},
  {"id": "back", "scope": "Anywhere", "keys": "Alt+Left", "label": "Back"},
  {"id": "forward", "scope": "Anywhere", "keys": "Alt+Right", "label": "Forward"},
  {"id": "fullscreen", "scope": "Anywhere", "keys": "F11", "label": "Toggle full screen"},
  {"id": "closeSettings", "scope": "Settings", "keys": "Escape", "label": "Close settings"},
  {"id": "send", "scope": "Composer", "keys": "Enter", "label": "Send (new line inside a code block)"},
  {"id": "steer", "scope": "Composer", "keys": "Mod+Enter", "label": "Send, including inside a code block"},
  {"id": "sendToMain", "editable": true, "scope": "Composer", "keys": "Mod+Shift+Enter", "label": "Send to main"},
  {"id": "bold", "scope": "Composer", "keys": "Mod+B", "label": "Bold"},
  {"id": "italic", "scope": "Composer", "keys": "Mod+I", "label": "Italic"},
  {"id": "inlineCode", "scope": "Composer", "keys": "Mod+E", "label": "Inline code"},
  {"id": "link", "scope": "Composer", "keys": "Mod+K", "label": "Insert link"},
  {"id": "undo", "scope": "Composer", "keys": "Mod+Z", "label": "Undo"},
  {"id": "redo", "legacyKeys": ["Mod+Y"], "scope": "Composer", "keys": "Mod+Shift+Z", "label": "Redo"},
  {"id": "stash", "editable": true, "scope": "Composer", "keys": "Mod+S", "label": "Stash, restore or swap draft"},
  {"id": "externalEditor", "editable": true, "scope": "Composer", "keys": "Mod+G", "label": "Edit prompt externally"},
  {"id": "escapeComposer", "scope": "Composer", "keys": "Escape", "label": "Dismiss completions, cancel turn, or double-tap for draft and rewind"},
  {"id": "reply", "editable": true, "scope": "Conversation", "keys": "R", "label": "Reply to selected text"},
  {"id": "fork", "editable": true, "scope": "Conversation", "keys": "F", "label": "Reply to selected text in a fork"},
  {"id": "pin", "scope": "Annotating a capture", "keys": "N", "label": "Pin"},
  {"id": "pen", "scope": "Annotating a capture", "keys": "F", "label": "Pen"},
  {"id": "highlighter", "scope": "Annotating a capture", "keys": "H", "label": "Highlighter"},
  {"id": "box", "scope": "Annotating a capture", "keys": "R", "label": "Box"},
  {"id": "arrow", "scope": "Annotating a capture", "keys": "A", "label": "Arrow"},
  {"id": "annotationUndo", "scope": "Annotating a capture", "keys": "Mod+Z", "label": "Undo annotation"},
  {"id": "annotationRedo", "legacyKeys": ["Mod+Shift+Z"], "scope": "Annotating a capture", "keys": "Mod+Y", "label": "Redo annotation"},
  {"id": "fit", "scope": "Annotating a capture", "keys": "0", "label": "Fit window"},
  {"id": "actualSize", "scope": "Annotating a capture", "keys": "1", "label": "Actual size"},
  {"id": "addCapture", "scope": "Annotating a capture", "keys": "Mod+Enter", "label": "Add capture to message"},
  {"id": "cancelAnnotation", "scope": "Annotating a capture", "keys": "Escape", "label": "Leave note or cancel annotation"},
  {"id": "openSession", "scope": "Session list", "keys": "Enter", "label": "Open focused session"},
  {"id": "renameSession", "scope": "Session list", "keys": "F2", "label": "Rename session"},
  {"id": "saveRename", "scope": "Renaming a session", "keys": "Enter", "label": "Save name"},
  {"id": "cancelRename", "scope": "Renaming a session", "keys": "Escape", "label": "Cancel rename"},
  {"id": "saveQueue", "scope": "Queued messages", "keys": "Enter", "label": "Save edit"},
  {"id": "cancelQueue", "scope": "Queued messages", "keys": "Escape", "label": "Cancel edit"},
  {"id": "submitRequest", "scope": "Questions and approvals", "keys": "Enter", "label": "Submit question or allow once"},
  {"id": "rejectRequest", "scope": "Questions and approvals", "keys": "Escape", "label": "Decline question or reject once"},
  {"id": "option1", "scope": "Questions and approvals", "keys": "1", "label": "Select option 1"},
  {"id": "option2", "scope": "Questions and approvals", "keys": "2", "label": "Select option 2"},
  {"id": "option3", "scope": "Questions and approvals", "keys": "3", "label": "Select option 3"},
  {"id": "option4", "scope": "Questions and approvals", "keys": "4", "label": "Select option 4"},
  {"id": "option5", "scope": "Questions and approvals", "keys": "5", "label": "Select option 5"},
  {"id": "option6", "scope": "Questions and approvals", "keys": "6", "label": "Select option 6"},
  {"id": "option7", "scope": "Questions and approvals", "keys": "7", "label": "Select option 7"},
  {"id": "option8", "scope": "Questions and approvals", "keys": "8", "label": "Select option 8"},
  {"id": "option9", "scope": "Questions and approvals", "keys": "9", "label": "Select option 9"},
  {"id": "nextChange", "editable": true, "scope": "Review", "keys": "N", "label": "Next change"},
  {"id": "previousChange", "editable": true, "scope": "Review", "keys": "P", "label": "Previous change"},
  {"id": "toggleComments", "editable": true, "scope": "Review", "keys": "Mod+Shift+H", "label": "Show or hide comments"},
  {"id": "resizeLeft", "scope": "Panel edges", "keys": "Left", "label": "Resize left"},
  {"id": "resizeRight", "scope": "Panel edges", "keys": "Right", "label": "Resize right"},
  {"id": "captureDisplay", "scope": "Screen capture", "keys": "Space", "label": "Capture whole display"},
  {"id": "cancelCapture", "scope": "Screen capture", "keys": "Escape", "label": "Cancel capture"},
]
export type Bindings = Record<string, string>
export const isMac = (platform: string): boolean => /Mac|darwin/i.test(platform)
export function defaultBinding(command: Command, mac = false): string {
  return command.id === 'fullscreen' && mac ? 'Ctrl+Super+F' : command.keys
}
const aliases: Record<string, string> = { control: 'Ctrl', ctrl: 'Ctrl', cmd: 'Super', command: 'Super', meta: 'Super', super: 'Super', win: 'Super', commandorcontrol: 'Mod', cmdorctrl: 'Mod', mod: 'Mod', shift: 'Shift', alt: 'Alt', option: 'Alt', esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', prtsc: 'PrintScreen', space: 'Space', plus: 'Plus' }
const named = ['Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Left', 'Right', 'Up', 'Down', 'PrintScreen', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec', ...Array.from({ length: 10 }, (_, i) => `num${i}`)]
const modifiers = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Super']
export function normalizeBinding(value: string): string | null {
  if (!value.trim()) return ''
  const parts = value.trim().replace(/\+\+$/, '+Plus').split('+').map(p => p.trim())
  const raw = parts.pop()!
  const key = aliases[raw.toLowerCase()] ?? named.find(k => k.toLowerCase() === raw.toLowerCase()) ?? (/^[a-z0-9,.;'[\]\\/`=-]$/i.test(raw) || /^F([1-9]|1\d|2[0-4])$/i.test(raw) ? raw.toUpperCase() : null)
  if (!key || modifiers.includes(key)) return null
  const mods = parts.map(p => aliases[p.toLowerCase()])
  if (mods.some(m => !modifiers.includes(m)) || new Set(mods).size !== mods.length) return null
  return [...modifiers.filter(m => mods.includes(m)), key].join('+')
}
export function concrete(keys: string, mac = false): string {
  return [...new Set(keys.replace(/Mod/g, mac ? 'Super' : 'Ctrl').split('+'))].sort().join('+')
}
export function bindingFor(id: string, bindings: Bindings = {}, mac = false): string {
  const command = COMMANDS.find(c => c.id === id)
  return (command?.editable ? bindings[id] : undefined) ?? (command ? defaultBinding(command, mac) : '')
}
// Modal canvases and focused controls consume their events before the app handlers.
const isolated = new Set(['Annotating a capture', 'Screen capture', 'Questions and approvals', 'Renaming a session', 'Queued messages'])
export function overlaps(a: Command, b: Command): boolean {
  if (a.scope === b.scope) return true
  if ([a.id, b.id].some(id => ['capture', 'fullscreen'].includes(id))) return true
  if ([a.id, b.id].some(id => ['folder', 'branch', 'pullRequest', 'obsidian'].includes(id)) && ![a.scope, b.scope].some(scope => ['Annotating a capture', 'Screen capture'].includes(scope))) return true
  if (isolated.has(a.scope) || isolated.has(b.scope)) return false
  if (a.scope === 'Anywhere' || b.scope === 'Anywhere') return true
  if (a.scope === 'Settings' || b.scope === 'Settings') return false
  // Escape cancellation and the review comment toggle also listen outside their editor.
  if ([a.id, b.id].some(id => ['escapeComposer', 'toggleComments'].includes(id))) return true
  if (a.scope === 'Composer' || b.scope === 'Composer') return false
  // A selection, review navigation and the sidebar can coexist in a session view.
  return true
}
export function bindingProblem(id: string, value: string, bindings: Bindings, mac = false): { message: string; conflict?: string } | null {
  const c = COMMANDS.find(c => c.id === id)
  if (!c) return { message: 'Unknown command.' }
  const normalized = normalizeBinding(value)
  if (!c.editable && normalized !== defaultBinding(c, mac)) return { message: `${c.label} is a fixed shortcut.` }
  if (normalized === null) return { message: 'Use one key with optional modifiers.' }
  if (!normalized) return null
  const keys = concrete(normalized, mac)
  const hasMod = /(^|\+)(Ctrl|Alt|Super|Mod)\+/.test(normalized)
  if (!hasMod && !/^F\d+$|^PrintScreen$/.test(normalized) && (c.scope === 'Anywhere' || (c.scope === 'Composer' && !['Enter', 'Escape'].includes(normalized)))) return { message: 'Add Ctrl, Alt or Command/Win so typing keeps working.' }
  if (!hasMod && ['Tab', 'Backspace', 'Delete', 'Space', 'Shift+Enter', 'Shift+Tab'].includes(normalized) && normalized !== defaultBinding(c, mac)) return { message: 'These keys are reserved for typing and keyboard navigation.' }
  if (!hasMod && normalized.length === 1 && ['Settings', 'Renaming a session', 'Queued messages'].includes(c.scope)) return { message: 'Add a modifier so typing keeps working.' }
  const reserved = ['Alt+F4', 'Ctrl+Alt+Delete', 'Super+L', 'Super+Tab', 'Alt+Tab', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+A', 'Mod+R', 'Mod+Shift+I', 'F12', 'Mod+Plus', 'Mod+=', 'Mod+-', 'Mod+0']
  if (reserved.some(k => concrete(k, mac) === keys) && keys !== concrete(defaultBinding(c, mac), mac)) return { message: 'These keys are reserved for the system, editing, or Electron.' }
  const other = COMMANDS.find(o => o.id !== id && overlaps(c, o) && [bindingFor(o.id, bindings, mac), ...((!o.editable || bindings[o.id] === undefined) ? o.legacyKeys ?? [] : [])].some(k => k && concrete(k, mac) === keys))
  return other ? other.editable ? { message: `Already used by ${other.label}. Clear that binding first.`, conflict: other.id } : { message: `Already used by ${other.label}, a fixed shortcut.` } : null
}

export function resolveBindings(raw: unknown, legacy?: string, mac = false): { bindings: Bindings; errors: string[] } {
  const bindings: Bindings = {}
  const errors: string[] = []
  if (legacy !== undefined) bindings.capture = normalizeBinding(legacy) ?? legacy
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) errors.push('shortcuts: expected an object of command IDs to keys.')
  else for (const [id, value] of Object.entries(raw ?? {})) {
    if (!COMMANDS.some(c => c.id === id) || typeof value !== 'string' || normalizeBinding(value) === null) { delete bindings[id]; errors.push(`shortcuts.${id}: invalid command or binding; using default.`) }
    else bindings[id] = normalizeBinding(value)!
  }
  // Recheck after fallback, since a restored default can conflict with another override.
  for (let pass = 0; pass <= COMMANDS.length; pass++) {
    let changed = false
    for (const [id, value] of Object.entries(bindings)) {
      const problem = bindingProblem(id, value, bindings, mac)
      if (problem) { delete bindings[id]; errors.push(`shortcuts.${id}: ${problem.message} Using default.`); changed = true }
    }
    if (!changed) break
  }
  for (const c of COMMANDS) if (bindings[c.id] === defaultBinding(c, mac)) delete bindings[c.id]
  return { bindings, errors }
}
export type KeyEvent = { key: string; code?: string; nativeEvent?: { isComposing?: boolean }; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; defaultPrevented?: boolean; getModifierState?(key: string): boolean }
export function matchesBinding(e: KeyEvent, keys: string, mac = false): boolean {
  if (!keys || e.isComposing || e.nativeEvent?.isComposing || e.getModifierState?.('AltGraph')) return false
  const numpad: Record<string, string> = { NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' }
  const numeric = e.code?.startsWith('Numpad') ? numpad[e.code] ?? `num${e.code.slice(6)}` : undefined
  const key = /\+num/.test(keys) && numeric ? numeric : e.key === ' ' ? 'Space' : e.key === '+' ? 'Plus' : aliases[e.key.toLowerCase()] ?? e.key
  const pressed = [...(e.ctrlKey ? ['Ctrl'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), ...(e.metaKey ? ['Super'] : []), key.length === 1 ? key.toUpperCase() : key].sort().join('+')
  return concrete(keys, mac) === pressed
}
