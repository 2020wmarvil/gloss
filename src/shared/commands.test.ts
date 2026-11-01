import { describe, expect, it } from 'vitest'
import { COMMANDS, bindingFor, bindingProblem, defaultBinding, matchesBinding, normalizeBinding, resolveBindings } from './commands'
const key = (key: string, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })
describe('command bindings', () => {
  it('has unique IDs and conflict-free defaults on both platforms', () => {
    expect(new Set(COMMANDS.map(c => c.id)).size).toBe(COMMANDS.length)
    for (const mac of [false, true]) for (const c of COMMANDS) {
      expect(normalizeBinding(defaultBinding(c, mac))).toBe(defaultBinding(c, mac))
      expect(bindingProblem(c.id, defaultBinding(c, mac), {}, mac), c.id).toBeNull()
    }
  })
  it('keeps Mod portable, matches exact modifiers and ignores IME and AltGr', () => {
    expect(normalizeBinding('shift + mod + k')).toBe('Mod+Shift+K')
    expect(matchesBinding(key('k', { ctrlKey: true }), 'Mod+K')).toBe(true)
    expect(matchesBinding(key('k', { metaKey: true }), 'Mod+K', true)).toBe(true)
    expect(matchesBinding(key('k', { ctrlKey: true }), 'Mod+K', true)).toBe(false)
    expect(matchesBinding(key('k', { ctrlKey: true, shiftKey: true }), 'Mod+K')).toBe(false)
    expect(matchesBinding(key('k', { ctrlKey: true, isComposing: true }), 'Mod+K')).toBe(false)
    expect(matchesBinding(key('k', { ctrlKey: true, getModifierState: () => true }), 'Mod+K')).toBe(false)
    expect(matchesBinding(key('Enter'), '')).toBe(false)
  })
  it('allows disjoint focused contexts and refuses simultaneous commands, including default aliases', () => {
    expect(bindingProblem('bold', 'Mod+I', {})).toMatchObject({ conflict: 'italic' })
    expect(bindingProblem('bold', 'Mod+Y', {})).toMatchObject({ conflict: 'redo' })
    expect(bindingProblem('nextChange', 'F', {})).toMatchObject({ conflict: 'fork' })
    expect(bindingProblem('bold', 'Mod+Shift+H', {})).toMatchObject({ conflict: 'toggleComments' })
    expect(bindingProblem('bold', 'Mod+N', {})).toMatchObject({ conflict: 'newSession' })
    expect(bindingProblem('pin', 'R', {})).toMatchObject({ conflict: 'box' })
    expect(bindingProblem('pin', 'R', { box: '' })).toBeNull()
    expect(bindingProblem('rejectRequest', 'Escape', {})).toBeNull()
    expect(bindingProblem('bold', 'Mod+I', { italic: '' })).toBeNull()
  })
  it('refuses typing and reserved keys but permits local letters on the canvas', () => {
    for (const keys of ['Q', 'Shift+Q', 'Alt+F4', 'Mod+C', 'Tab', 'Shift+Enter']) expect(bindingProblem('bold', keys, {})).not.toBeNull()
    expect(bindingProblem('pin', 'Q', {})).toBeNull()
    expect(bindingProblem('capture', 'Escape', {})).not.toBeNull()
  })
  it('falls back per command, including cascading default collisions', () => {
    const result = resolveBindings({ search: 'garbage', bold: 'Mod+I', italic: 'Mod+N', stash: '', unknown: 'F8' })
    expect(result.bindings).toEqual({ stash: '' })
    expect(result.errors.join(' ')).toContain('search')
    expect(result.errors.join(' ')).toContain('bold')
    expect(bindingFor('bold', result.bindings)).toBe('Mod+B')
  })
  it('honors legacy capture settings, then explicit overrides, including disabled', () => {
    expect(resolveBindings(undefined, 'Ctrl+Shift+S').bindings.capture).toBe('Ctrl+Shift+S')
    expect(resolveBindings({ capture: '' }, 'Ctrl+Shift+S').bindings.capture).toBe('')
    expect(resolveBindings({ capture: 'bad key' }, 'Ctrl+Shift+S').bindings.capture).toBeUndefined()
  })
})
