import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Settings } from '../shared/ipc'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): Settings {
  // The cheap dev model is on by default in development, off in packaged builds.
  return { devModel: !app.isPackaged }
}

let cached: Settings | undefined

export function getSettings(): Settings {
  if (cached) return cached
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
  } catch {
    // Missing or unreadable settings file: use defaults.
  }
  const base = defaults()
  cached = { devModel: typeof stored.devModel === 'boolean' ? stored.devModel : base.devModel }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cached = { ...getSettings(), ...patch }
  writeFileSync(settingsPath(), JSON.stringify(cached, null, 2))
  return cached
}
