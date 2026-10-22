// Bridge OpenCode's config format to a custom profile's instruction-file argument.
// Usage: node opencode-custom-acp.mjs <native-opencode-executable> <instructions-file>
import process from 'node:process'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [executable, instructionFile, ...args] = process.argv.slice(2)
if (!executable || !instructionFile) throw new Error('Expected an OpenCode executable and instruction file.')
readFileSync(instructionFile, 'utf8')
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}')
if (!config || typeof config !== 'object' || Array.isArray(config)
  || (config.instructions !== undefined && (!Array.isArray(config.instructions) || config.instructions.some((v) => typeof v !== 'string')))) {
  throw new Error('OPENCODE_CONFIG_CONTENT must be an object with an optional instructions array.')
}
const child = spawn(executable, ['acp', ...args], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, instructions: [...new Set([...(config.instructions ?? []), instructionFile])] }) }
})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
// Losing the ACP client's input closes the native agent, including when the wrapper exits.
process.stdin.on('end', () => child.kill())
child.stdin.on('error', () => {})
child.on('error', () => { process.stderr.write('Could not start OpenCode. Check the native executable path.\n'); process.exitCode = 1; process.stdin.destroy() })
child.on('exit', (code) => { process.exitCode = code ?? 1; process.stdin.destroy() })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())
