import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentConnection } from './acp'
import { findOpenCodeExecutable, openCodeConfigContent, OpenCodeSupport, OPENCODE_INSTRUCTIONS } from './opencode'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gloss-opencode-test-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

function binary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '', { mode: 0o755 })
  return path
}

it('discovers a native Windows desktop CLI when the npm command is absent from PATH', () => {
  const installed = join(dir, 'ai.opencode.desktop', 'cli')
  binary(join(installed, '2.0.9-x64', 'opencode-cli.exe'))
  const newest = binary(join(installed, '2.0.32-x64', 'opencode-cli.exe'))
  expect(findOpenCodeExecutable('', { APPDATA: dir, PATH: '' }, 'win32')).toBe(newest)
  expect(() => findOpenCodeExecutable(join(dir, 'missing.exe'), { APPDATA: dir }, 'win32')).toThrow(/not found/)
  expect(() => findOpenCodeExecutable('opencode.cmd', {}, 'win32')).toThrow(/native/)
})

it('finds native executables on PATH on Windows and Linux', () => {
  const win = binary(join(dir, 'opencode.exe'))
  expect(findOpenCodeExecutable('', { PATH: dir }, 'win32')).toBe(win)
  const unix = binary(join(dir, 'opencode'))
  expect(findOpenCodeExecutable('', { PATH: dir }, 'linux')).toBe(unix)
})

it('preserves native provider configuration and instruction paths, without duplicating ours', () => {
  const original = { model: 'ollama/qwen3.5:latest', providers: { ollama: { settings: { baseURL: 'http://localhost:11434/v1' } } }, instructions: ['team.md'] }
  const content = openCodeConfigContent('C:/Gloss/instructions.md', JSON.stringify(original))
  expect(JSON.parse(openCodeConfigContent('C:/Gloss/instructions.md', content))).toEqual({
    ...original, instructions: ['team.md', 'C:/Gloss/instructions.md']
  })
  expect(() => openCodeConfigContent('ours.md', 'secret')).toThrow(/JSON object/)
  expect(() => openCodeConfigContent('ours.md', '{"instructions":"invalid"}')).toThrow(/array/)
})

it('checks ACP without creating a session or prompting, caches checks, and supplies a separate instruction file', async () => {
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify({ model: 'ollama/qwen3.5:latest', instructions: ['native.md'] }))
  const executable = binary(join(dir, 'opencode.exe'))
  const dispose = vi.fn()
  const connect = vi.fn(async () => ({ init: { agentInfo: { name: 'OpenCode', version: '2.0.32' } }, dispose }) as unknown as AgentConnection)
  const support = new OpenCodeSupport(join(dir, 'gloss'), connect)
  expect(await support.check(executable)).toEqual({ available: true, executable, version: '2.0.32', error: null })
  await support.check(executable)
  expect(connect).toHaveBeenCalledTimes(1)
  expect(dispose).toHaveBeenCalledTimes(1)
  const supplied = JSON.parse(support.config(executable).env!.OPENCODE_CONFIG_CONTENT)
  expect(supplied.model).toBe('ollama/qwen3.5:latest')
  expect(supplied.instructions[0]).toBe('native.md')
  expect(readFileSync(supplied.instructions[1], 'utf8')).toBe(OPENCODE_INSTRUCTIONS)
  expect(OPENCODE_INSTRUCTIONS).toContain('path:line')
  await support.check(executable, true)
  expect(connect).toHaveBeenCalledTimes(2)
})

it('rejects incompatible agents and redacts arbitrary startup errors', async () => {
  const executable = binary(join(dir, 'opencode.exe'))
  const dispose = vi.fn()
  const old = new OpenCodeSupport(dir, async () => ({ init: { agentInfo: { name: 'OpenCode', version: '1.19.3' } }, dispose }) as unknown as AgentConnection)
  expect(await old.check(executable)).toMatchObject({ available: false, error: expect.stringContaining('v2') })
  expect(dispose).toHaveBeenCalledOnce()
  const failing = new OpenCodeSupport(dir, async () => { throw new Error('apiKey=do-not-print') })
  const result = await failing.check(executable)
  expect(result.available).toBe(false)
  expect(result.error).not.toContain('do-not-print')
})

it('bounds initialization of a process that never speaks ACP', async () => {
  await expect(AgentConnection.start({
    id: 'silent', name: 'Silent', command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], startupTimeoutMs: 50
  }, process.env, {
    onUpdate() {}, onStderr() {}, onClosed() {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } })
  })).rejects.toThrow(/initialization timed out/)
})
