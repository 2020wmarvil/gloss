import { shortcutLabel } from '@shared/shortcut'
import { COMMANDS, bindingFor, isMac, matchesBinding, type Bindings, type KeyEvent } from '@shared/commands'
import type { GlobalSettings } from '@shared/settings'
let bindings: Bindings = {}
export const MAC = typeof navigator !== 'undefined' && isMac(navigator.userAgent)
export function configureBindings(settings: Pick<GlobalSettings, 'shortcuts' | 'captureShortcut'>): void {
  bindings = { ...(settings.captureShortcut !== undefined ? { capture: settings.captureShortcut } : {}), ...settings.shortcuts }
}
export function commandKeys(id: string): string { return bindingFor(id, bindings, MAC) }
export function commandMatches(e: KeyEvent, id: string): boolean {
  if (typeof document !== 'undefined' && document.querySelector('.shortcut-field.recording')) return false
  if (matchesBinding(e, commandKeys(id), MAC)) return true
  // Existing defaults accepted either primary modifier and a few editor aliases.
  // A user override replaces the whole default, including its compatibility aliases.
  const c = COMMANDS.find(c => c.id === id)
  if (bindings[id] !== undefined || !c) return false
  return [c.keys, ...(c.legacyKeys ?? [])].some(keys => matchesBinding(e, keys, MAC) || (keys.includes('Mod') && matchesBinding(e, keys, !MAC)))
}

export function commandLabel(id: string): string { return shortcutLabel(commandKeys(id).replace(/Mod/g, MAC ? 'Super' : 'Ctrl'), MAC) }
export function commandHint(id: string): string { const label = commandLabel(id); return label ? ` (${label})` : '' }
