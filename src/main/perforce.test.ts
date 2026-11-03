import { describe, expect, it, vi } from 'vitest'
import { perforceRange, perforceRef } from '../shared/perforce'
import { firstPassPrompt } from '../shared/review'
import { inside, p4Path, parsePerforceRecords, perforceContextPaths, perforceDiff, perforceRefs, perforceWorkspace, perforceNotOpened, perforceFilePath, perforceStatus } from './perforce'
import { resolve } from 'node:path'

describe('Perforce input boundaries', () => {
  it('reports a missing CLI without treating it as an unmapped folder', async () => {
    vi.stubEnv('PATH', '')
    try { await expect(perforceWorkspace(process.cwd())).rejects.toMatchObject({ kind: 'missing' }) }
    finally { vi.unstubAllEnvs() }
  })
  it('keeps client identity and validates selections without accepting command fragments', () => {
    const ref = perforceRef('client: with spaces', '123')
    expect(perforceRange(ref)).toEqual({ client: 'client: with spaces', change: '123' })
    expect(perforceRange('origin/main')).toBeNull()
    for (const change of ['-a', '1 ...', '0', '../other']) expect(() => perforceRef('client', change)).toThrow()
    expect(() => perforceRange('p4:client:submitted')).toThrow()
  })
  it('escapes revision and wildcard syntax in literal paths', () => {
    expect(p4Path('a@b#c%d*e')).toBe('a%40b%23c%25d%2Ae')
    expect(inside(resolve('workspace'), resolve('workspace-other/file'))).toBe(false)
    expect(inside(resolve('workspace'), resolve('workspace/sub/file'))).toBe(true)
  })
  it('preserves structured errors on stdout', () => {
    expect(parsePerforceRecords('{"severity":3,"generic":36,"data":"expired"}\n')).toEqual([{ severity: 3, generic: 36, data: 'expired' }])
    expect(parsePerforceRecords('')).toEqual([])
  })
})

// Opt-in against the throwaway sandbox only. Never pointed at a user's workspace in CI.
describe.skipIf(!process.env.GLOSS_P4_TEST_WORKSPACE || !!process.env.GLOSS_P4_EXPECT_ERROR)('live isolated Perforce reader', () => {
  const cwd = process.env.GLOSS_P4_TEST_WORKSPACE ?? ''
  it('detects the configured workspace and lists pending ranges', async () => {
    const workspace = await perforceWorkspace(cwd)
    expect(workspace.client).toBe('gloss-classic')
    const refs = await perforceRefs(cwd, perforceRef(workspace.client))
    expect(refs.perforce?.changes.slice(0, 2).map((r) => r.label)).toEqual(['Workspace', 'Default changelist'])
  })
  it('reads the workspace and gives the agent Perforce context', async () => {
    const diff = await perforceDiff(cwd, perforceRef('gloss-classic'))
    expect(diff.perforce?.workspace.client).toBe('gloss-classic')
    expect(firstPassPrompt(diff)).toContain('p4 opened')
    expect(firstPassPrompt(diff)).not.toContain('git diff')
    expect(diff.files.every((f) => !f.path.includes('..'))).toBe(true)
  }, 30000)
  it('lists attachable workspace files', async () => {
    const paths = await perforceContextPaths(cwd)
    expect(paths).toContain('src/main.c')
  }, 30000)
  it.skipIf(!process.env.GLOSS_P4_TEST_SEEDED)('covers additions, deletions, moves, binaries, ignored tracked files and unopened changes', async () => {
    const diff = await perforceDiff(cwd, perforceRef('gloss-classic'))
    const file = (path: string) => diff.files.find((f) => f.path === path)
    expect(file('src/main.c')).toMatchObject({ status: 'modified', additions: 1, deletions: 1, perforce: { opened: true } })
    expect(file('src/added.c')).toMatchObject({ status: 'added', additions: 1 })
    expect(file('src/delete-me.c')).toMatchObject({ status: 'deleted', deletions: 1 })
    expect(file('src/renamed.c')).toMatchObject({ status: 'renamed', oldPath: 'src/rename-me.c' })
    expect(file('art/texture.bin')).toMatchObject({ binary: true })
    expect(file('README.md')).toMatchObject({ status: 'deleted', perforce: { opened: false } })
    expect(file('src/new.c')).toMatchObject({ status: 'added', perforce: { opened: false } })
    if (process.env.GLOSS_P4_TEST_STREAM) expect(file('src/naïve café.txt')).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    expect(file('src/ignored.tmp')).toBeUndefined()
    const paths = await perforceContextPaths(cwd)
    expect(paths).toContain('src/crlf.txt')
    expect(paths).not.toContain('src/ignored.tmp')
    expect(paths).not.toContain('src/café.tmp')
    expect(paths).not.toContain('generated/ignored.c')
    expect(await perforceNotOpened(cwd, ['src/new.c', 'src/new.c', 'src/main.c'])).toBe(1)
    expect(await perforceNotOpened(cwd, ['src', cwd])).toBe(0)
    const subfolder = await perforceDiff(resolve(cwd, 'src'), perforceRef('gloss-classic'))
    expect(subfolder.files.find((f) => f.path === 'art/texture.bin')?.outside).toBe(true)
    expect(subfolder.files.find((f) => f.path === 'README.md')).toBeUndefined()
    const refs = await perforceRefs(cwd, perforceRef('gloss-classic'))
    const numbered = refs.perforce!.changes.find((c) => c.label.includes('Integration fixture'))!
    expect((await perforceDiff(cwd, numbered.ref)).files.map((f) => f.path)).toEqual(['src/main.c'])
    await expect(perforceWorkspace(resolve(cwd, 'unmapped'))).rejects.toThrow()
    await expect(perforceFilePath(cwd, '../tickets.txt', perforceRef('gloss-classic'))).rejects.toThrow()
  }, 30000)
  it.skipIf(!process.env.GLOSS_P4_TEST_STREAM)('detects stream workspaces', async () => {
    const workspace = await perforceWorkspace(process.env.GLOSS_P4_TEST_STREAM!)
    expect(workspace.stream).toBe('//streams/main')
  })
})

it.skipIf(!process.env.GLOSS_P4_TEST_WORKSPACE || !process.env.GLOSS_P4_EXPECT_ERROR)('reports real login, expiration and connection failures', async () => {
  const cwd = process.env.GLOSS_P4_TEST_WORKSPACE!
  await expect(perforceWorkspace(cwd)).rejects.toMatchObject({ kind: process.env.GLOSS_P4_EXPECT_ERROR })
  const status = await perforceStatus(cwd)
  expect(status.perforce).toBe(true)
  expect(status.tooltip).toContain(process.env.GLOSS_P4_EXPECT_ERROR === 'unavailable' ? 'connection' : 'p4 login')
}, 30000)
