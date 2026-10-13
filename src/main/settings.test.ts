import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SettingsState } from '../shared/ipc'
import { parseSettings, patchArg, samePath, SettingsFile } from './settings'

const defaults = { devModel: false }

describe('parseSettings', () => {
  it('fills in defaults and ignores unknown keys', () => {
    expect(parseSettings('{"$schema": "x", "future": 1}', defaults)).toEqual({
      ok: true,
      global: { devModel: false },
      projects: {}
    })
  })

  it('reads known values and projects', () => {
    expect(parseSettings('{"devModel": true, "projects": {"C:\\\\a": {"x": 1}}}', defaults)).toEqual({
      ok: true,
      global: { devModel: true },
      projects: { 'C:\\a': {} }
    })
  })

  it('reports invalid JSON', () => {
    const parsed = parseSettings('{"devModel": tru', defaults)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/^Invalid JSON/)
  })

  it('reports every invalid value', () => {
    const parsed = parseSettings('{"devModel": "yes", "projects": {"a": 3}}', defaults)
    expect(parsed).toEqual({
      ok: false,
      error: 'devModel: expected true or false, got "yes"\nprojects["a"]: expected an object'
    })
  })

  it('rejects a non-object file', () => {
    expect(parseSettings('[]', defaults).ok).toBe(false)
  })
})

describe('patchArg', () => {
  it('accepts known settings with valid values', () => {
    expect(patchArg({ global: { devModel: true } })).toEqual({ global: { devModel: true } })
  })

  it('rejects unknown keys, bad values and bad shapes', () => {
    expect(() => patchArg({ global: { nope: 1 } })).toThrow(/Unknown global setting/)
    expect(() => patchArg({ global: { devModel: 'yes' } })).toThrow(/devModel/)
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
    expect(state).toEqual({ path: path(), global: { devModel: false }, projects: {}, error: null })
    expect(onDisk()).toEqual({ $schema: './settings.schema.json', devModel: false })
    const schema = JSON.parse(readFileSync(join(dir, 'settings.schema.json'), 'utf8')) as {
      properties: Record<string, { type: string; default?: unknown }>
    }
    expect(schema.properties.devModel).toMatchObject({ type: 'boolean', default: false })
  })

  it('reads an existing file without changing it', () => {
    writeFileSync(path(), '{"devModel": true}')
    expect(file.load().global.devModel).toBe(true)
    expect(readFileSync(path(), 'utf8')).toBe('{"devModel": true}')
  })

  it('reads a file with a BOM', () => {
    writeFileSync(path(), '\uFEFF{"devModel": true}')
    expect(file.load()).toMatchObject({ global: { devModel: true }, error: null })
  })

  it('keeps the last good settings when an edit breaks the file', () => {
    writeFileSync(path(), '{"devModel": true}')
    file.load()
    writeFileSync(path(), '{"devModel": true,')
    file.reload()
    expect(file.state().global.devModel).toBe(true)
    expect(file.state().error).toMatch(/^Invalid JSON/)
    // The broken file is left alone.
    expect(readFileSync(path(), 'utf8')).toBe('{"devModel": true,')

    writeFileSync(path(), '{"devModel": "no"}')
    file.reload()
    expect(file.state()).toMatchObject({ global: { devModel: true }, error: /devModel/ })

    writeFileSync(path(), '{"devModel": false}')
    file.reload()
    expect(file.state()).toMatchObject({ global: { devModel: false }, error: null })
  })

  it('reports a deleted file and recreates it on save', () => {
    file.load()
    rmSync(path())
    file.reload()
    expect(file.state().error).toMatch(/missing/)
    file.update({ global: { devModel: true } })
    expect(file.state()).toMatchObject({ global: { devModel: true }, error: null })
    expect(onDisk()).toEqual({ $schema: './settings.schema.json', devModel: true })
  })

  it('saves changed keys and keeps unknown ones', () => {
    writeFileSync(path(), '{"devModel": false, "future": {"a": 1}, "projects": {"/p": {"later": true}}}')
    file.load()
    const state = file.update({ global: { devModel: true } })
    expect(state.global.devModel).toBe(true)
    expect(onDisk()).toEqual({
      $schema: './settings.schema.json',
      devModel: true,
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
    expect(() => file.update({ global: { devModel: true } })).toThrow(/isn't a valid JSON object/)
    expect(readFileSync(path(), 'utf8')).toBe('{oops')
  })

  it('reports changes once, and not for no-op reloads', () => {
    file.load()
    changes = []
    file.reload()
    expect(changes).toEqual([])
    file.update({ global: { devModel: true } })
    expect(changes.map((c) => c.global.devModel)).toEqual([true])
  })

  it('picks up edits made by other programs while watching', async () => {
    file.load()
    file.watch()
    changes = []
    writeFileSync(path(), '{"devModel": true}')
    await waitFor(() => changes.length > 0)
    expect(file.state()).toMatchObject({ global: { devModel: true }, error: null })
  })
})

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
