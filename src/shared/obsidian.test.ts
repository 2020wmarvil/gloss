import { expect, it } from 'vitest'
import { obsidianUri } from './obsidian'
import { projectSettings } from './settings'

it('encodes vault names as a single parameter, including reserved characters and Unicode', () => {
  const vault = ' Notes & plans #1 / \u65e5\u672c\u8a9e?file=other '
  const url = new URL(obsidianUri(vault))
  expect(url.protocol).toBe('obsidian:')
  expect(url.hostname).toBe('open')
  expect([...url.searchParams]).toEqual([['vault', vault.trim()]])
})

it('matches Windows project paths across casing, separators, and trailing slashes', () => {
  const projects = { 'C:/Work/Project/': { obsidianVault: 'Notes' } }
  expect(projectSettings(projects, 'c:/work/project').obsidianVault).toBe('Notes')
  expect(projectSettings(projects, '/another-project').obsidianVault).toBeUndefined()
})
