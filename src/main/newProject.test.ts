import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject, initProject, projectNameError, projectsFolder } from './newProject'

describe('projectNameError', () => {
  it('accepts an ordinary folder name', () => {
    expect(projectNameError('my-app')).toBeNull()
    expect(projectNameError('Notes 2026')).toBeNull()
  })

  it('refuses anything that could leave the projects folder', () => {
    for (const name of ['', '  ', '..', '.', 'a/b', 'a\\b', '../x', 'C:x']) expect(projectNameError(name)).not.toBeNull()
  })

  it("refuses names Windows can't hold", () => {
    for (const name of ['con', 'NUL.txt', 'lpt1', 'a?', 'trailing.', ' lead', 'x'.repeat(101)]) expect(projectNameError(name)).not.toBeNull()
  })
})

describe('projectsFolder', () => {
  it('uses the setting, else the Desktop folder', () => {
    expect(projectsFolder(' D:\\code ')).toBe('D:\\code')
    expect(projectsFolder('')).toMatch(/Desktop$/)
    expect(projectsFolder(undefined)).toMatch(/Desktop$/)
  })
})

describe('createProject', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('makes the folder, inside a projects folder that may not exist yet, as a git repository', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-new-'))
    const path = await createProject(join(dir, 'projects'), 'app')
    expect(path).toBe(join(dir, 'projects', 'app'))
    expect(existsSync(join(path, '.git'))).toBe(true)
  })

  it('refuses a folder that exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-new-'))
    await createProject(dir, 'app')
    await expect(createProject(dir, 'app')).rejects.toThrow(/already exists/)
  })
})

describe('initProject', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('makes an empty picked folder, or one that does not exist yet, a git repository', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-init-'))
    expect(await initProject(dir)).toBe(dir)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    const fresh = join(dir, 'nested', 'app')
    await initProject(fresh)
    expect(existsSync(join(fresh, '.git'))).toBe(true)
  })

  it('refuses a folder with anything in it, and leaves it alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gloss-init-'))
    writeFileSync(join(dir, 'notes.txt'), 'keep')
    await expect(initProject(dir)).rejects.toThrow(/isn't empty/)
    expect(existsSync(join(dir, '.git'))).toBe(false)
    expect(readdirSync(dir)).toEqual(['notes.txt'])
  })
})
