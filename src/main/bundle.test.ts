// Size budgets for the build (SPEC → Performance). Runs against `out/`, so CI builds before
// testing; skipped when there is no build. Raise a budget only on purpose, in its own commit.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const out = join(__dirname, '../../out')
const KB = 1024

function folderSize(dir: string): number {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .reduce((n, f) => n + statSync(join(f.parentPath, f.name)).size, 0)
}

describe.skipIf(!existsSync(join(out, 'renderer/index.html')))('bundle size', () => {
  it('keeps what the main window loads before its first paint within budget', () => {
    // The page's own scripts and the chunks it preloads; languages and screens load later.
    const html = readFileSync(join(out, 'renderer/index.html'), 'utf8')
    const scripts = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.js)"/g)].map((m) => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    const size = scripts.reduce((n, f) => n + statSync(join(out, 'renderer', f)).size, 0)
    expect(size / KB).toBeLessThan(3300)
  })

  it('keeps the whole renderer and the main process within budget', () => {
    expect(folderSize(join(out, 'renderer')) / KB).toBeLessThan(13500)
    expect(folderSize(join(out, 'main')) / KB).toBeLessThan(1100)
  })
})
