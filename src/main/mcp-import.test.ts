import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { previewMcpImport } from './mcp-import'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gloss-mcp-import-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))
function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

it('discovers Claude global, local project and project-file entries without changing their files', () => {
  const project = join(home, 'BoxPuzzler2024')
  const path = join(home, '.claude.json')
  const text = JSON.stringify({ mcpServers: { global: { command: 'global-mcp' } }, projects: {
    [project]: { mcpServers: { UnityMCP: { type: 'http', url: 'http://127.0.0.1:8080/mcp' } }, disabledMcpjsonServers: ['disabled'] }
  } })
  write(path, text)
  write(join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
    project: { command: 'project-mcp', args: ['--project'], env: { TOKEN: '${TOKEN}', DEFAULT: '${MISSING:-default}' } },
    disabled: { command: 'disabled-mcp' },
    missing: { type: 'http', url: 'https://example.com', headers: { Authorization: '${MISSING_TOKEN}' } }
  } }))
  const preview = previewMcpImport('claude', { home, env: { TOKEN: 'test-token' }, projects: [project] })
  expect(preview.problems).toEqual([])
  expect(preview.entries).toHaveLength(5)
  expect(preview.entries.find((e) => e.name === 'global')?.server).toEqual({ name: 'global', command: 'global-mcp', args: [], env: [] })
  expect(preview.entries.find((e) => e.name === 'UnityMCP')).toMatchObject({ source: expect.stringContaining(project), server: { type: 'http', headers: [] } })
  expect(preview.entries.find((e) => e.name === 'project')?.server).toMatchObject({ env: [{ name: 'TOKEN', value: 'test-token' }, { name: 'DEFAULT', value: 'default' }] })
  expect(preview.entries.find((e) => e.name === 'disabled')).toMatchObject({ problem: expect.stringContaining('Disabled') })
  expect(preview.entries.find((e) => e.name === 'missing')).toMatchObject({ problem: expect.stringContaining('MISSING_TOKEN') })
  expect(readFileSync(path, 'utf8')).toBe(text)
})

it('parses Codex TOML including quoted names, env tables and HTTP credential references', () => {
  const codexHome = join(home, 'custom-codex')
  const project = join(home, 'project')
  write(join(codexHome, 'config.toml'), `
[mcp_servers."local tools"]
command = 'C:\\tools\\mcp.exe'
args = ["--mode", "test"]
env_vars = ["INHERITED", "UNSET_OPTIONAL", { name = "LOCAL", source = "local" }]
[mcp_servers."local tools".env]
MODE = "local"
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "TOKEN"
http_headers = { Region = "us" }
env_http_headers = { "X-Tenant" = "TENANT" }
[mcp_servers.off]
enabled = false
command = "disabled"
[mcp_servers.restricted]
command = "restricted"
enabled_tools = ["read"]
[mcp_servers.cwd]
command = "local"
cwd = "/project"
`)
  write(join(project, '.codex', 'config.toml'), '[mcp_servers.project]\ncommand = "project-mcp"\n')
  const preview = previewMcpImport('codex', { home, env: { CODEX_HOME: codexHome, INHERITED: 'yes', LOCAL: 'local', TOKEN: 'secret', TENANT: 'one' }, projects: [project] })
  expect(preview.problems).toEqual([])
  expect(preview.entries).toHaveLength(6)
  expect(preview.entries[0].server).toMatchObject({ name: 'local tools', command: 'C:\\tools\\mcp.exe', env: [{ name: 'MODE', value: 'local' }, { name: 'INHERITED', value: 'yes' }, { name: 'LOCAL', value: 'local' }] })
  expect(preview.entries[1].server).toMatchObject({ type: 'http', headers: [{ name: 'Region', value: 'us' }, { name: 'X-Tenant', value: 'one' }, { name: 'Authorization', value: 'Bearer secret' }] })
  expect(preview.entries[2].server).toBeUndefined()
  expect(preview.entries[3].problem).toContain('enabled_tools')
  expect(preview.entries[4].problem).toContain('cwd')
  expect(preview.entries[5].name).toBe('project')
})

it('reports bad files without echoing their contents and continues discovering other sources', () => {
  const project = join(home, 'project')
  write(join(home, '.codex', 'config.toml'), 'SECRET_TOKEN = "do-not-print\n')
  write(join(project, '.codex', 'config.toml'), '[mcp_servers.valid]\ncommand = "valid"')
  const preview = previewMcpImport('codex', { home, env: {}, projects: [project] })
  expect(preview.problems).toHaveLength(1)
  expect(preview.problems[0]).not.toContain('do-not-print')
  expect(preview.entries[0].name).toBe('valid')
  expect(previewMcpImport('claude', { home, env: {} })).toEqual({ entries: [], problems: [] })
})

it('supports Claude config-directory overrides and retains old Gloss project entries for explicit import', () => {
  const configDir = join(home, 'custom-claude')
  write(join(configDir, '.claude.json'), JSON.stringify({ mcpServers: { custom: { command: 'custom' } } }))
  expect(previewMcpImport('claude', { home, env: { CLAUDE_CONFIG_DIR: configDir } }).entries[0].name).toBe('custom')
  const server = { name: 'legacy', command: 'legacy', args: [], env: [] }
  expect(previewMcpImport('gloss', { legacy: { '/old-project': { mcpServers: [server] } } }).entries).toMatchObject([{ name: 'legacy', source: '/old-project', server }])
})
