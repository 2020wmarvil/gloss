// SPEC → Performance: long code is colored in the background, a few lines per slice with
// the grammar's state carried between them, so it matches coloring it in one piece.
import { expect, it, vi } from 'vitest'
import { codeColors, colorsInBackground } from './highlight'

it('colors long code in several tasks, the same as in one piece', async () => {
  await vi.waitFor(() => expect(codeColors('let a = 1', 'typescript')).not.toBeNull(), { timeout: 10000 })
  // A template string and a block comment cross slice boundaries.
  const lines = Array.from({ length: 600 }, (_, i) => `export function f${i}(x: string): number { return x.length + ${i} }`)
  lines.splice(18, 0, 'const t = `one', 'two ${lines.length} three', 'four`')
  lines.splice(39, 0, '/* a comment', 'that spans', 'lines */')
  const code = lines.join('\n')
  // The same code and a line more: not cached, colored in one piece.
  const whole = codeColors(code + '\n', 'typescript')!.slice(0, code.length)

  const timeout = vi.spyOn(globalThis, 'setTimeout')
  let colors: (string | undefined)[] | null | undefined
  colorsInBackground(code, 'typescript', (c) => {
    colors = c
  })
  expect(colors).toBeUndefined()
  await vi.waitFor(() => expect(colors).toBeDefined(), { timeout: 10000 })
  expect(colors).toEqual(whole)
  expect(timeout.mock.calls.length).toBeGreaterThan(1)
  timeout.mockRestore()

  // Known colors come at once; a cancelled job never calls back.
  let again: unknown
  colorsInBackground(code, 'typescript', (c) => (again = c))
  expect(again).toBe(colors)
  const done = vi.fn()
  colorsInBackground(code + '\n\n', 'typescript', done)()
  await new Promise((r) => setTimeout(r, 200))
  expect(done).not.toHaveBeenCalled()
}, 30000)
