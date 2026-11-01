import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneRepo, parseRepos } from './github'

describe('parseRepos', () => {
  it('reads one repository per line, newest push first, without duplicates', () => {
    const line = (name: string, pushed: string | null, extra = {}): string =>
      JSON.stringify({ full_name: name, description: '', private: false, fork: false, archived: false, pushed_at: pushed, ...extra })
    const repos = parseRepos(
      [
        line('me/old', '2025-01-01T00:00:00Z'),
        line('org/new', '2026-10-01T00:00:00Z', { private: true, description: 'Tools' }),
        line('me/empty', null),
        line('me/old', '2025-01-01T00:00:00Z'),
        ''
      ].join('\n')
    )
    expect(repos.map((r) => r.fullName)).toEqual(['org/new', 'me/old', 'me/empty'])
    expect(repos[0]).toMatchObject({ private: true, description: 'Tools', pushedAt: Date.parse('2026-10-01T00:00:00Z') })
    expect(repos[1].description).toBeNull()
    expect(repos[2].pushedAt).toBe(0)
  })
})

describe('cloneRepo', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const parent = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'gloss-clone-'))
    dirs.push(d)
    return d
  }

  it('opens a folder that is already a clone of the repository', async () => {
    const p = parent()
    const dest = join(p, 'widgets')
    mkdirSync(dest)
    execFileSync('git', ['init', '-q'], { cwd: dest })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git'], { cwd: dest })
    await expect(cloneRepo('https://github.com/acme/widgets', p)).resolves.toBe(dest)
  })

  it('refuses a folder holding something else', async () => {
    const p = parent()
    mkdirSync(join(p, 'widgets'))
    writeFileSync(join(p, 'widgets', 'notes.txt'), 'mine')
    await expect(cloneRepo('acme/widgets', p)).rejects.toThrow('already exists')
  })

  it('refuses a name that is not a repository', async () => {
    await expect(cloneRepo('widgets', parent())).rejects.toThrow("isn't a GitHub repository")
  })
})
