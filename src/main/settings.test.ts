import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SettingsState } from '../shared/ipc'
import { parseSettings, patchArg, samePath, SettingsFile } from './settings'

const defaults = { defaultAgent: 'claude' as const, theme: 'system' as const, sessionOrder: 'created' as const, listItemReplies: false }

describe('parseSettings', () => {
  it('accepts and validates the list item replies toggle', () => {
    for (const listItemReplies of [true, false]) {
      expect(parseSettings(JSON.stringify({ listItemReplies }), defaults)).toMatchObject({
        ok: true, global: { listItemReplies }
      })
      expect(patchArg({ global: { listItemReplies } })).toEqual({ global: { listItemReplies } })
    }
    expect(parseSettings('{"listItemReplies":"false"}', defaults).ok).toBe(false)
    expect(() => patchArg({ global: { listItemReplies: 'false' } })).toThrow(/listItemReplies/)
  })

  it('accepts Codex as the default agent and rejects unknown agents', () => {
    expect(parseSettings('{"defaultAgent":"codex"}', defaults)).toMatchObject({
      ok: true, global: { defaultAgent: 'codex' }
    })
    expect(() => patchArg({ global: { defaultAgent: 'unknown' } })).toThrow(/defaultAgent/)
  })
  it('fills in defaults and ignores unknown and retired keys', () => {
    expect(parseSettings('{"$schema": "x", "future": 1, "devModel": true}', defaults)).toEqual({
      ok: true,
      global: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false },
      projects: {}
    })
  })

  it('accepts only the listed values of an enum', () => {
    expect(parseSettings('{"theme": "dark"}', defaults)).toMatchObject({ ok: true, global: { theme: 'dark' } })
    expect(parseSettings('{"theme": "blue"}', defaults)).toEqual({
      ok: false,
      error: 'theme: expected one of "system", "light", "dark", got "blue"'
    })
  })

  it('reads known values and projects', () => {
    expect(parseSettings('{"theme": "dark", "projects": {"C:\\\\a": {"x": 1}}}', defaults)).toEqual({
      ok: true,
      global: { defaultAgent: 'claude', theme: 'dark', sessionOrder: 'created', listItemReplies: false },
      projects: { 'C:\\a': {} }
    })
  })

  it('reports invalid JSON', () => {
    const parsed = parseSettings('{"theme": "dar', defaults)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/^Invalid JSON/)
  })

  it('reports every invalid value', () => {
    const parsed = parseSettings('{"theme": "blue", "projects": {"a": 3}}', defaults)
    expect(parsed).toEqual({
      ok: false,
      error: 'theme: expected one of "system", "light", "dark", got "blue"\nprojects["a"]: expected an object'
    })
  })

  it('rejects a non-object file', () => {
    expect(parseSettings('[]', defaults).ok).toBe(false)
  })
})

describe('patchArg', () => {
  it('accepts known settings with valid values', () => {
    expect(patchArg({ global: { theme: 'dark' } })).toEqual({ global: { theme: 'dark' } })
  })

  it('rejects unknown keys, bad values and bad shapes', () => {
    expect(() => patchArg({ global: { nope: 1 } })).toThrow(/Unknown global setting/)
    expect(() => patchArg({ global: { sessionOrder: 'yes' } })).toThrow(/sessionOrder/)
    expect(() => patchArg({ global: { theme: 'blue' } })).toThrow(/theme/)
    expect(() => patchArg(null)).toThrow()
    expect(() => patchArg({ project: { values: {} } })).toThrow()
  })
})

describe('samePath', () => {
  it('ignores case on Windows only', () => {
    expect(samePath('/A/b', '/a/B', 'win32')).toBe(true)
    expect(samePath('/A/b', '/a/B', 'linux')).toBe(false)
    expect(samePath('/a/b/', '/a/b', 'linux')).toBe(true)
  })
})

describe('SettingsFile', () => {
  let dir: string
  let file: SettingsFile
  let changes: SettingsState[]

  const path = (): string => join(dir, 'settings.json')
  const onDisk = (): Record<string, unknown> => JSON.parse(readFileSync(path(), 'utf8')) as Record<string, unknown>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-settings-'))
    changes = []
    file = new SettingsFile({ dir, defaults, onChange: (next) => changes.push(next) })
  })

  afterEach(() => {
    file.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file and its schema on first load', () => {
    const state = file.load()
    expect(state).toEqual({ path: path(), global: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false }, projects: {}, error: null })
    expect(onDisk()).toEqual({ $schema: './settings.schema.json', defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false })
    const schema = JSON.parse(readFileSync(join(dir, 'settings.schema.json'), 'utf8')) as {
      properties: Record<string, { type: string; default?: unknown; enum?: unknown[] }>
    }
    expect(schema.properties).not.toHaveProperty('devModel')
    expect(schema.properties.theme).toMatchObject({ type: 'string', default: 'system', enum: ['system', 'light', 'dark'] })
  })

  it('reads an existing file without changing it', () => {
    writeFileSync(path(), '{"theme": "dark"}')
    expect(file.load().global.theme).toBe('dark')
    expect(readFileSync(path(), 'utf8')).toBe('{"theme": "dark"}')
  })

  it('reads a file with a BOM', () => {
    writeFileSync(path(), '\uFEFF{"theme": "dark"}')
    expect(file.load()).toMatchObject({ global: { theme: 'dark' }, error: null })
  })

  it('keeps the last good settings when an edit breaks the file', () => {
    writeFileSync(path(), '{"theme": "dark"}')
    file.load()
    writeFileSync(path(), '{"theme": "dark",')
    file.reload()
    expect(file.state().global.theme).toBe('dark')
    expect(file.state().error).toMatch(/^Invalid JSON/)
    // The broken file is left alone.
    expect(readFileSync(path(), 'utf8')).toBe('{"theme": "dark",')

    writeFileSync(path(), '{"theme": "no"}')
    file.reload()
    expect(file.state()).toMatchObject({ global: { theme: 'dark' }, error: /theme/ })

    writeFileSync(path(), '{"theme": "light"}')
    file.reload()
    expect(file.state()).toMatchObject({ global: { theme: 'light' }, error: null })
  })

  it('reports a deleted file and recreates it on save', () => {
    file.load()
    rmSync(path())
    file.reload()
    expect(file.state().error).toMatch(/missing/)
    file.update({ global: { theme: 'dark' } })
    expect(file.state()).toMatchObject({ global: { theme: 'dark' }, error: null })
    expect(onDisk()).toEqual({ $schema: './settings.schema.json', theme: 'dark' })
  })

  it('saves changed keys and keeps unknown ones', () => {
    writeFileSync(path(), '{"theme": "light", "future": {"a": 1}, "projects": {"/p": {"later": true}}}')
    file.load()
    const state = file.update({ global: { theme: 'dark' } })
    expect(state.global.theme).toBe('dark')
    expect(onDisk()).toEqual({
      $schema: './settings.schema.json',
      theme: 'dark',
      future: { a: 1 },
      projects: { '/p': { later: true } }
    })
  })

  it('writes project settings under the existing key for the same folder', () => {
    const key = process.platform === 'win32' ? 'C:\\Proj' : '/proj'
    const other = process.platform === 'win32' ? 'c:\\proj\\' : '/proj/'
    writeFileSync(path(), JSON.stringify({ projects: { [key]: { keep: 1 } } }))
    file.load()
    file.update({ project: { path: other, values: {} } })
    expect(onDisk().projects).toEqual({ [key]: { keep: 1 } })
  })

  it("won't save over a file that isn't valid JSON", () => {
    file.load()
    writeFileSync(path(), '{oops')
    expect(() => file.update({ global: { theme: 'dark' } })).toThrow(/isn't a valid JSON object/)
    expect(readFileSync(path(), 'utf8')).toBe('{oops')
  })

  it('reports changes once, and not for no-op reloads', () => {
    file.load()
    changes = []
    file.reload()
    expect(changes).toEqual([])
    file.update({ global: { theme: 'dark' } })
    expect(changes.map((c) => c.global.theme)).toEqual(['dark'])
  })

  it('picks up edits made by other programs while watching', async () => {
    file.load()
    file.watch()
    changes = []
    writeFileSync(path(), '{"theme": "dark"}')
    await waitFor(() => changes.length > 0)
    expect(file.state()).toMatchObject({ global: { theme: 'dark' }, error: null })
  })
})

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
