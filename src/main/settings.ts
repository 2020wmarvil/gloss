// settings.json (SPEC → Settings): loading, validation, live reload and writes.
// No Electron imports, so it can be tested against a temp folder.

import { type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeShortcut } from '../shared/shortcut'
import { mcpError } from '../shared/mcp'
import { PROFILE_ID, profilesError } from '../shared/agentProfiles'
import type { SettingsPatch, SettingsState } from '../shared/ipc'
import {
  type GlobalSettings,
  type ProjectSettings,
  SCHEMA_FILE,
  SETTING_FIELDS,
  type SettingField,
  SETTINGS_FILE
} from '../shared/settings'

type Raw = Record<string, unknown>

/** What a new or saved file's `$schema` points at; editors resolve it next to the file. */
const SCHEMA_REF = `./${SCHEMA_FILE}`

const profileSchema = {
  type: 'array', items: {
    type: 'object', required: ['id', 'name', 'command', 'args', 'env'],
    properties: {
      id: { type: 'string', pattern: '^custom:[a-z0-9][a-z0-9-]{0,63}$' },
      name: { type: 'string', minLength: 1 }, command: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, additionalProperties: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
      instructionsEnv: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }
    },
    anyOf: [{ required: ['instructionsEnv'] }, { properties: { args: { contains: { type: 'string', pattern: '\\{instructions\\}' } } } }]
  }
}

const pairsSchema = { type: 'array', items: { type: 'object', required: ['name', 'value'], properties: { name: { type: 'string', minLength: 1 }, value: { type: 'string' } } } }
const mcpSchema = {
  type: 'array', items: { oneOf: [
    { type: 'object', required: ['name', 'command', 'args', 'env'], not: { required: ['type'] }, properties: {
      name: { type: 'string', minLength: 1 }, command: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string' } }, env: pairsSchema
    } },
    { type: 'object', required: ['type', 'name', 'url', 'headers'], properties: {
      type: { enum: ['http', 'sse'] }, name: { type: 'string', minLength: 1 },
      url: { type: 'string', pattern: '^https?://' }, headers: pairsSchema
    } }
  ] }
}

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fields(scope: SettingField['scope']): SettingField[] {
  return SETTING_FIELDS.filter((f) => f.scope === scope)
}

/** Why `value` isn't valid for `field`, or null if it is. */
function checkValue(field: SettingField, value: unknown): string | null {
  switch (field.type) {
    case 'profiles': return profilesError(value)
    case 'agent': return typeof value === 'string' && (['claude', 'codex', 'opencode'].includes(value) || PROFILE_ID.test(value)) ? null : 'expected a built-in agent or custom profile ID'
    case 'mcp': return mcpError(value)
    case 'boolean':
      return typeof value === 'boolean' ? null : `expected true or false, got ${JSON.stringify(value)}`
    case 'string':
      return typeof value === 'string' ? null : `expected a string, got ${JSON.stringify(value)}`
    case 'shortcut':
      return typeof value === 'string' && (value.trim() === '' || normalizeShortcut(value) !== null)
        ? null
        : `expected a key combination like "Ctrl+Shift+PrintScreen", or "" for none, got ${JSON.stringify(value)}`
    case 'enum': {
      const values = field.options?.map((o) => o.value) ?? []
      return values.includes(value as string)
        ? null
        : `expected one of ${values.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`
    }
  }
}

/** Copies the valid known fields of `scope` from `source` into `target`, collecting errors under `prefix`. */
function readFields(scope: SettingField['scope'], source: Raw, target: Raw, prefix: string, errors: string[]): void {
  for (const field of fields(scope)) {
    if (!(field.key in source)) continue
    const error = checkValue(field, source[field.key])
    if (error) errors.push(`${prefix}${field.key}: ${error}`)
    else target[field.key] = source[field.key]
  }
}

export type Parsed =
  | { ok: true; global: GlobalSettings; projects: Record<string, ProjectSettings> }
  | { ok: false; error: string }

/** Validates settings.json's text. Missing keys take their defaults; unknown keys are ignored. */
export function parseSettings(text: string, defaults: GlobalSettings): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isObject(raw)) return { ok: false, error: 'The file must contain a JSON object.' }

  const errors: string[] = []
  const global: Raw = { ...defaults }
  readFields('global', raw, global, '', errors)
  const projects: Record<string, Raw> = {}
  if ('projects' in raw) {
    if (!isObject(raw.projects)) {
      errors.push('projects: expected an object keyed by folder path')
    } else {
      for (const [path, value] of Object.entries(raw.projects)) {
        if (!isObject(value)) {
          errors.push(`projects[${JSON.stringify(path)}]: expected an object`)
          continue
        }
        projects[path] = {}
        readFields('project', value, projects[path], `projects[${JSON.stringify(path)}].`, errors)
      }
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('\n') }
  return {
    ok: true,
    global: global as GlobalSettings,
    projects: projects as Record<string, ProjectSettings>
  }
}

/** The JSON Schema written next to settings.json, for editors and agents. */
export function settingsSchema(defaults: GlobalSettings): object {
  const properties = (scope: SettingField['scope'], defaultsFor?: Raw): Raw =>
    Object.fromEntries(
      fields(scope).map((f) => [
        f.key,
        {
          ...(f.type === 'mcp' ? mcpSchema : f.type === 'profiles' ? profileSchema : f.type === 'agent' ? { type: 'string', pattern: '^(claude|codex|opencode|custom:[a-z0-9][a-z0-9-]{0,63})$' } : { type: f.type === 'enum' || f.type === 'shortcut' ? 'string' : f.type }),
          ...(f.options && f.type !== 'agent' ? { enum: f.options.map((o) => o.value) } : {}),
          description: f.description,
          default: defaultsFor?.[f.key]
        }
      ])
    )
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Gloss settings',
    description:
      'Settings for Gloss. Global settings go at the top level, per-project settings under "projects". Gloss reloads this file when it changes; invalid edits are reported and the last good settings are kept.',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      ...properties('global', defaults),
      projects: {
        type: 'object',
        description: "Per-project settings, keyed by the project folder's absolute path.",
        additionalProperties: { type: 'object', properties: properties('project') }
      }
    }
  }
}

/** Checks a patch from the renderer: known keys of the right scope, valid values. */
export function patchArg(value: unknown): SettingsPatch {
  if (!isObject(value)) throw new Error('Invalid settings patch')
  const check = (scope: SettingField['scope'], values: unknown): void => {
    if (!isObject(values)) throw new Error('Invalid settings patch')
    for (const [key, v] of Object.entries(values)) {
      const field = fields(scope).find((f) => f.key === key)
      if (!field) throw new Error(`Unknown ${scope} setting: ${key}`)
      const error = checkValue(field, v)
      if (error) throw new Error(`${key}: ${error}`)
    }
  }
  const patch: SettingsPatch = {}
  if (value.global !== undefined) {
    check('global', value.global)
    patch.global = value.global as SettingsPatch['global']
  }
  if (value.project !== undefined) {
    const p = value.project
    if (!isObject(p) || typeof p.path !== 'string') throw new Error('Invalid settings patch')
    check('project', p.values)
    patch.project = { path: p.path, values: p.values as Partial<ProjectSettings> }
  }
  return patch
}

/** Whether two folder paths name the same folder (case-insensitively on Windows). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const r = resolve(p)
    return platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

type Options = {
  /** The folder holding settings.json and its schema (Gloss's data folder). */
  dir: string
  defaults: GlobalSettings
  /** Called whenever the settings or the error change. */
  onChange?(next: SettingsState, prev: SettingsState): void
}

/**
 * Owns settings.json. Invalid JSON or values keep the last good settings and set
 * `error`; the file itself is never reset or overwritten because of a bad edit.
 */
export class SettingsFile {
  readonly path: string
  private current: SettingsState
  /** The text the current state was read from, to skip no-op reloads. */
  private lastText: string | null | undefined
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly opts: Options) {
    this.path = join(opts.dir, SETTINGS_FILE)
    this.current = { path: this.path, global: { ...opts.defaults }, projects: {}, error: null }
  }

  state(): SettingsState {
    return this.current
  }

  /** Writes the schema, creates settings.json if it doesn't exist, and reads it. */
  load(): SettingsState {
    mkdirSync(this.opts.dir, { recursive: true })
    const schema = JSON.stringify(settingsSchema(this.opts.defaults), null, 2) + '\n'
    const schemaPath = join(this.opts.dir, SCHEMA_FILE)
    try {
      if (this.read(schemaPath) !== schema) writeFileSync(schemaPath, schema)
    } catch {
      // The schema only helps editors; settings work without it.
    }
    if (this.read(this.path) === null) {
      writeFileSync(this.path, serialize({ $schema: SCHEMA_REF, ...this.opts.defaults }))
    }
    this.reload()
    return this.current
  }

  /** Reloads on changes to settings.json. Watches the folder, since editors often replace the file. */
  watch(): void {
    if (this.watcher) return
    this.watcher = watch(this.opts.dir, (_event, filename) => {
      if (filename && filename !== SETTINGS_FILE) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.reload(), 50)
    })
    this.watcher.on('error', () => {
      // The folder went away; nothing more to watch.
    })
  }

  close(): void {
    clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = undefined
  }

  /** Re-reads the file and applies it if it changed. */
  reload(): void {
    let text: string | null
    try {
      text = this.read(this.path)
    } catch {
      // Locked mid-save (EBUSY on Windows, say): try again shortly.
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.reload(), 200)
      return
    }
    if (text === this.lastText) return
    this.lastText = text
    if (text === null) {
      this.apply({ ...this.current, error: `${SETTINGS_FILE} is missing. Saving a setting here recreates it.` })
      return
    }
    const parsed = parseSettings(text, this.opts.defaults)
    this.apply(
      parsed.ok
        ? { path: this.path, global: parsed.global, projects: parsed.projects, error: null }
        : { ...this.current, error: parsed.error }
    )
  }

  /**
   * Writes the patched keys into the file, keeping every other key (known or not).
   * Throws without writing if the file isn't valid JSON.
   */
  update(patch: SettingsPatch): SettingsState {
    const text = this.read(this.path)
    let raw: Raw = {}
    if (text !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (!isObject(parsed)) {
        throw new Error(`${SETTINGS_FILE} isn't a valid JSON object. Fix it in an editor first; Gloss won't overwrite it.`)
      }
      raw = parsed
    }
    if (!('$schema' in raw)) raw = { $schema: SCHEMA_REF, ...raw }
    Object.assign(raw, patch.global)
    if (patch.project) {
      if ('projects' in raw && !isObject(raw.projects)) {
        throw new Error(`"projects" in ${SETTINGS_FILE} isn't an object. Fix it in an editor first.`)
      }
      const projects = (raw.projects ?? {}) as Raw
      const { path, values } = patch.project
      const key = Object.keys(projects).find((k) => samePath(k, path)) ?? path
      projects[key] = { ...(isObject(projects[key]) ? projects[key] : {}), ...values }
      raw.projects = projects
    }
    writeFileSync(this.path, serialize(raw))
    this.reload()
    return this.current
  }

  private apply(next: SettingsState): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return
    const prev = this.current
    this.current = next
    this.opts.onChange?.(next, prev)
  }

  /** The file's text without a BOM (Notepad writes one), or null if it doesn't exist. */
  private read(path: string): string | null {
    try {
      return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }
}

function serialize(raw: Raw): string {
  return JSON.stringify(raw, null, 2) + '\n'
}
