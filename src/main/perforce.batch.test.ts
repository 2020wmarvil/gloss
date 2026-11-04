// SPEC → Performance: reading a Perforce review's diff takes a fixed number of p4
// commands plus one print per file, not several commands per file. p4 is a fake here
// that answers from the arguments and counts the commands run.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { perforceRef } from '../shared/perforce'

const p4 = vi.hoisted(() => ({ root: '', files: 0, commands: [] as string[] }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (_bin: string, argv: string[], _options: unknown, done: (err: Error | null, stdout: Buffer, stderr: Buffer) => void) => {
      const args = [...argv]
      let paths: string[] = []
      while (args.length) {
        const a = args[0]
        if (a === '-L' || a === '-C') args.splice(0, 2)
        else if (a === '-ztag' || a === '-Mj') args.shift()
        else if (a === '-x') {
          paths = readFileSync(args[1], 'utf8').split('\n').filter(Boolean)
          args.splice(0, 2)
        } else break
      }
      const [name, ...rest] = args
      p4.commands.push(name)
      const tagged = (records: Record<string, string>[]): string => records.map((r) => Object.entries(r).map(([k, v]) => `... ${k} ${v}`).join('\n') + '\n\n').join('')
      const depotPath = (depot: string): string => join(p4.root, depot.replace('//depot/', ''))
      const out =
        name === 'info' ? tagged([{ clientRoot: p4.root, clientName: 'bench', userName: 'gloss', serverAddress: 'localhost:1666' }])
        : name === 'login' ? tagged([{ User: 'gloss' }])
        : name === 'change' ? tagged([{ Change: rest[1], Status: 'pending', Client: 'bench' }])
        : name === 'where' ? tagged(paths.map((p): Record<string, string> => (p.endsWith('/...') ? { depotFile: '//depot/...', path: p } : { depotFile: p, clientFile: p, path: depotPath(p) })))
        : name === 'opened' ? tagged(Array.from({ length: p4.files }, (_, i) => ({ depotFile: `//depot/f${i}.txt`, action: 'edit', change: '7', type: 'text' })))
        : name === 'fstat' ? tagged(paths.map((p) => ({ depotFile: p, headType: 'text', fileSize: '4' })))
        : name === 'print' ? 'old\n'
        : ''
      setImmediate(() => done(null, Buffer.from(out), Buffer.from('')))
      return { stdin: { end() {} } }
    }
  }
})
import { perforceDiff } from './perforce'

beforeEach(async () => {
  p4.root = await mkdtemp(join(tmpdir(), 'gloss-p4-batch-'))
})
afterEach(async () => {
  await rm(p4.root, { recursive: true, force: true })
})

it('reads a changelist with a fixed number of p4 commands plus a print per file', async () => {
  const counts: Record<number, { other: number; prints: number }> = {}
  for (const files of [5, 40]) {
    p4.files = files
    p4.commands = []
    for (let i = 0; i < files; i++) await writeFile(join(p4.root, `f${i}.txt`), 'new\n')
    const diff = await perforceDiff(p4.root, perforceRef('bench', '7'))
    expect(diff.files).toHaveLength(files)
    expect(diff.files.every((f) => f.status === 'modified' && f.additions === 1 && f.deletions === 1)).toBe(true)
    counts[files] = { other: p4.commands.filter((c) => c !== 'print').length, prints: p4.commands.filter((c) => c === 'print').length }
  }
  // info, where and login for the workspace, change, opened, then one where and one fstat for every file.
  expect(counts[5]).toEqual({ other: 7, prints: 5 })
  expect(counts[40]).toEqual({ other: 7, prints: 40 })
})
