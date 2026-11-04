import { describe, expect, it, vi } from 'vitest'
import { AgentClis, findCli, parseVersion, versionAtLeast, type FindOptions } from './agentCli'

const win = (files: string[], extra: Partial<FindOptions> = {}): FindOptions => ({
  platform: 'win32', arch: 'x64', home: 'C:\\Users\\u',
  env: { Path: 'C:\\tools;"C:\\Users\\u\\AppData\\Roaming\\npm"' },
  exists: (path) => files.includes(path),
  codexApps: async () => [],
  ...extra
})

describe('findCli', () => {
  it('uses the configured path, and refuses wrappers or missing files', async () => {
    expect(await findCli('claude', ' D:\\claude.exe ', win(['D:\\claude.exe']))).toBe('D:\\claude.exe')
    await expect(findCli('codex', 'C:\\npm\\codex.cmd', win([]))).rejects.toThrow(/codexExecutable to the native codex\.exe/)
    await expect(findCli('claude', 'D:\\gone.exe', win([]))).rejects.toThrow(/wasn't found at D:\\gone\.exe/)
  })

  it('prefers a native executable on PATH', async () => {
    expect(await findCli('claude', '', win(['C:\\tools\\claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe']))).toBe('C:\\tools\\claude.exe')
  })

  it("finds the binary behind npm's .cmd shims", async () => {
    const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm'
    expect(await findCli('claude', '', win([`${npm}\\claude.cmd`, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`])))
      .toBe(`${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`)
    const codex = `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
    expect(await findCli('codex', '', win([`${npm}\\codex.cmd`, codex]))).toBe(codex)
  })

  it("falls back to Claude's installer folder and the newest Codex app", async () => {
    expect(await findCli('claude', '', win(['C:\\Users\\u\\.local\\bin\\claude.exe']))).toBe('C:\\Users\\u\\.local\\bin\\claude.exe')
    const apps = async () => ['C:\\WindowsApps\\OpenAI.Codex_26.9.1.0_x64__x', 'C:\\WindowsApps\\OpenAI.Codex_26.10.1.0_x64__x']
    const newest = 'C:\\WindowsApps\\OpenAI.Codex_26.10.1.0_x64__x\\app\\resources\\codex.exe'
    expect(await findCli('codex', '', win([newest, 'C:\\WindowsApps\\OpenAI.Codex_26.9.1.0_x64__x\\app\\resources\\codex.exe'], { codexApps: apps }))).toBe(newest)
  })

  it('says how to install a missing CLI', async () => {
    await expect(findCli('codex', '', win([]))).rejects.toThrow("Codex wasn't found. Install the Codex CLI")
    await expect(findCli('claude', '', { platform: 'linux', home: '/home/u', env: { PATH: '/usr/bin' }, exists: () => false }))
      .rejects.toThrow(/set its path as claudeExecutable/)
    expect(await findCli('claude', '', { platform: 'linux', home: '/home/u', env: { PATH: '/usr/bin' }, exists: (p) => p === '/home/u/.local/bin/claude' }))
      .toBe('/home/u/.local/bin/claude')
  })
})

describe('versions', () => {
  it('reads the versions both CLIs print', () => {
    expect(parseVersion('2.1.233 (Claude Code)')).toEqual([2, 1, 233])
    expect(parseVersion('codex-cli 0.166.0-alpha.5.1')).toEqual([0, 166, 0])
    expect(parseVersion('unknown')).toBeNull()
  })

  it('compares numerically', () => {
    expect(versionAtLeast([2, 1, 233], '2.1.233')).toBe(true)
    expect(versionAtLeast([2, 1, 1000], '2.1.233')).toBe(true)
    expect(versionAtLeast([2, 1, 150], '2.1.233')).toBe(false)
    expect(versionAtLeast([1, 9, 999], '2.1.233')).toBe(false)
  })
})

describe('AgentClis', () => {
  it('reports a CLI too old for the adapter, with how to update it', async () => {
    const clis = new AgentClis({ find: async () => 'C:\\claude.exe', version: async () => '2.1.150 (Claude Code)' })
    expect(await clis.check('claude')).toEqual({
      available: false, executable: 'C:\\claude.exe', version: '2.1.150',
      error: 'Claude Code 2.1.150 is too old for Gloss (it needs 2.1.316 or newer). Run `claude update`.'
    })
    await expect(clis.resolve('claude')).rejects.toThrow(/too old/)
  })

  it('caches checks, and looks again before failing a start', async () => {
    let installed = false
    const find = vi.fn(async () => { if (!installed) throw new Error("Codex wasn't found."); return '/bin/codex' })
    let now = 0
    const clis = new AgentClis({ find, version: async () => 'codex-cli 0.166.0' }, () => now)
    const changed = vi.fn()
    clis.changed = changed
    expect(clis.known('codex')).toBeUndefined()
    await clis.check('codex')
    expect(clis.known('codex')?.available).toBe(false)
    expect(find).toHaveBeenCalledOnce()
    installed = true
    expect(await clis.resolve('codex')).toBe('/bin/codex')
    expect(changed).toHaveBeenCalledWith('codex')
    now = 31_000
    expect(clis.known('codex')?.available).toBe(true)
    expect(find).toHaveBeenCalledTimes(3)
  })
})
