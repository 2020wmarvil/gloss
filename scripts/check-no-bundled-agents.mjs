/* global console, process */
// Fails if a packaged app in dist/ contains the Claude Code or Codex CLI. They are
// user-installed (SPEC → Shipping) and must never ship. Run it after electron-builder.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import asar from '@electron/asar'

const FORBIDDEN = [
  /(^|\/)@anthropic-ai\/claude-agent-sdk-[^/]+(\/|$)/,
  /(^|\/)@openai\/codex(-[^/]+)?(\/|$)/,
  /(^|\/)(claude|codex)(\.exe)?$/i
]
const isForbidden = (path) => FORBIDDEN.some((pattern) => pattern.test(path.replaceAll('\\', '/')))

const root = process.argv[2] ?? 'dist'
const entries = readdirSync(root, { recursive: true, withFileTypes: true })
const archives = entries.filter((e) => e.isFile() && e.name.endsWith('.asar')).map((e) => join(e.parentPath, e.name))
if (archives.length === 0) {
  console.error(`No packaged app in ${root}: run electron-builder first.`)
  process.exit(1)
}

const found = [
  ...entries.map((e) => join(e.parentPath, e.name)),
  ...archives.flatMap((archive) => asar.listPackage(archive).map((file) => `${archive}:${file}`))
].filter(isForbidden)

if (found.length > 0) {
  console.error(`The packaged app contains an agent CLI:\n${found.slice(0, 20).join('\n')}`)
  process.exit(1)
}
console.log(`No agent CLI in ${archives.length} packaged app(s).`)
