import { expect, it } from 'vitest'
import { runComposerShell } from './composerShell'

// A real shell: PowerShell's cold start on a busy Windows CI runner can take more than the default 5 s.
const SHELL_TIMEOUT = 30_000

it('captures shell stdout, stderr and exit status without an agent', async () => {
  const command = process.platform === 'win32' ? "Write-Output 'hello'; [Console]::Error.WriteLine('problem'); exit 7" : "printf hello; printf problem >&2; exit 7"
  const result = await runComposerShell(process.cwd(), command, new AbortController().signal)
  expect(result.output).toContain('hello')
  expect(result.output).toContain('problem')
  expect(result.exitCode).toBe(7)
}, SHELL_TIMEOUT)

it('cancels a running command and reports cancellation', async () => {
  const controller = new AbortController()
  const pending = runComposerShell(process.cwd(), process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', controller.signal)
  controller.abort()
  expect((await pending).output).toContain('[Cancelled]')
}, SHELL_TIMEOUT)

it('executes line-separated commands in the same shell without flattening the newlines', async () => {
  const command = process.platform === 'win32' ? "$value = 'first'\nWrite-Output $value\nWrite-Output 'second'" : "value=first\nprintf '%s\\n' \"$value\"\nprintf 'second\\n'"
  const result = await runComposerShell(process.cwd(), command, new AbortController().signal)
  expect(result.exitCode).toBe(0)
  expect(result.output.trim().split(/\r?\n/)).toEqual(['first', 'second'])
}, SHELL_TIMEOUT)
