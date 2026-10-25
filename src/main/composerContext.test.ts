import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { attachPathContext, contextPaths, externalContextItems, gitOutput, pathContextItems } from './composerContext'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gloss-context-'))
  dirs.push(dir)
  return dir
}
const item = (id: string, kind: 'file' | 'folder' = 'file') => ({ kind, id, label: id, description: '' })

it('offers Git files and folders, respects ignores, and attaches folder contents', async () => {
  const cwd = await project()
  await gitOutput(cwd, ['init'])
  await mkdir(join(cwd, 'src'))
  await writeFile(join(cwd, 'src', 'main.ts'), 'const answer = 42')
  await writeFile(join(cwd, '.gitignore'), 'private.txt\n')
  await writeFile(join(cwd, 'private.txt'), 'secret')
  const paths = await contextPaths(cwd)
  expect(paths).toContain('src/main.ts')
  expect(paths).not.toContain('private.txt')
  expect(pathContextItems(paths, 'src')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'folder', id: 'src/' })]))
  expect(await attachPathContext(cwd, item('src/','folder'))).toMatchObject({ kind: 'file', text: '## src/main.ts\n\nconst answer = 42' })
})

it('rejects traversal, symlinks out of the project, binary and oversized context', async () => {
  const cwd = await project()
  const outside = await project()
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await expect(attachPathContext(cwd, item('../' + outside.split(/[\\/]/).pop() + '/secret.txt'))).rejects.toThrow('outside')
  await symlink(outside, join(cwd, 'linked'), 'junction')
  await expect(attachPathContext(cwd, item('linked/secret.txt'))).rejects.toThrow('outside')
  await writeFile(join(cwd, 'binary.dat'), 'a\0b')
  await expect(attachPathContext(cwd, item('binary.dat'))).rejects.toThrow('UTF-8')
  await writeFile(join(cwd, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
  await expect(attachPathContext(cwd, item('large.txt'))).rejects.toThrow('1 MB')
})

it('browses home-relative and absolute paths and attaches a file outside the project', async () => {
  const cwd = await project()
  const home = await project()
  await mkdir(join(home, 'Downloads'))
  await mkdir(join(home, 'Downloads', 'My Files'))
  await writeFile(join(home, 'Downloads', 'note.txt'), 'outside context')
  const homeItems = await externalContextItems(cwd, '~/Down', home)
  expect(homeItems).toContainEqual(expect.objectContaining({ label: '~/Downloads/', browse: true }))
  const items = await externalContextItems(cwd, '~/Downloads/', home)
  expect(items).toContainEqual(expect.objectContaining({ label: '~/Downloads/My Files/', kind: 'folder', browse: true }))
  const note = items!.find((item) => item.kind === 'file')!
  expect(await attachPathContext(cwd, note)).toMatchObject({ name: 'note.txt', text: 'outside context' })
  const absolute = await externalContextItems(cwd, join(home, 'Downloads', 'no'), home)
  expect(absolute).toContainEqual(expect.objectContaining({ id: note.id }))
  expect(await externalContextItems(cwd, 'src/main', home)).toBeNull()
  expect(await externalContextItems(cwd, '//server/share/', home)).toEqual([])
})

it('browses explicitly relative parent directories without scanning them recursively', async () => {
  const home = await project()
  const cwd = join(home, 'work')
  await mkdir(cwd)
  await writeFile(join(home, 'outside.txt'), 'outside')
  expect(await externalContextItems(cwd, '../', home)).toContainEqual(expect.objectContaining({ label: expect.stringContaining('outside.txt') }))
})
