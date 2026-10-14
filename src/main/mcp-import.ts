import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { mcpError, type McpImportPreview, type McpImportSource, type McpServer } from '../shared/mcp'
import type { ProjectSettings } from '../shared/settings'

type Raw = Record<string, unknown>
type Options = { home?: string; env?: NodeJS.ProcessEnv; projects?: string[]; legacy?: Record<string, ProjectSettings> }
const object = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value)

function pairs(value: unknown): { name: string; value: string }[] {
  if (value === undefined) return []
  if (!object(value) || Object.values(value).some((v) => typeof v !== 'string')) throw new Error('Expected name/value strings')
  return Object.entries(value).map(([name, value]) => ({ name, value: value as string }))
}

function envValue(name: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof name !== 'string' || env[name] === undefined) throw new Error(`Environment variable ${typeof name === 'string' ? name : '(invalid name)'} is unavailable in Gloss`)
  return env[name]!
}

function claudeValues(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => env[name] ?? fallback ?? envValue(name, env))
  if (Array.isArray(value)) return value.map((v) => claudeValues(v, env))
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, claudeValues(v, env)]))
  return value
}

function convert(name: string, raw: unknown, agent: 'claude' | 'codex', env: NodeJS.ProcessEnv): McpServer {
  if (!object(raw)) throw new Error('Expected a server object')
  if (raw.enabled === false || raw.disabled === true) throw new Error('Disabled in the source configuration')
  const config = (agent === 'claude' ? claudeValues(raw, env) : raw) as Raw
  // ACP cannot express these settings. Do not silently drop restrictions or change execution context.
  const unsupported = ['cwd', 'enabled_tools', 'disabled_tools', 'tools', 'http_headers_helper', 'headersHelper', 'oauth', 'auth', 'experimental_environment']
    .filter((key) => config[key] !== undefined)
  if (unsupported.length) throw new Error(`Cannot preserve these settings: ${unsupported.join(', ')}`)
  let server: McpServer
  if (config.url !== undefined || config.type === 'http' || config.type === 'sse') {
    if (config.type !== undefined && config.type !== 'http' && config.type !== 'streamable-http' && config.type !== 'sse') throw new Error('Unsupported transport')
    const headers = pairs(agent === 'codex' ? config.http_headers : config.headers)
    if (agent === 'codex') {
      for (const h of pairs(config.env_http_headers)) headers.push({ name: h.name, value: envValue(h.value, env) })
      if (config.bearer_token_env_var !== undefined) {
        for (let i = headers.length - 1; i >= 0; i--) if (headers[i].name.toLowerCase() === 'authorization') headers.splice(i, 1)
        headers.push({ name: 'Authorization', value: `Bearer ${envValue(config.bearer_token_env_var, env)}` })
      }
    }
    server = { name, type: config.type === 'sse' ? 'sse' : 'http', url: config.url as string, headers }
  } else {
    if (config.type !== undefined && config.type !== 'stdio') throw new Error('Unsupported transport')
    const variables = new Map(pairs(config.env).map((p) => [p.name, p.value]))
    if (agent === 'codex' && config.env_vars !== undefined) {
      if (!Array.isArray(config.env_vars)) throw new Error('Expected a list of environment variables')
      for (const entry of config.env_vars) {
        if (object(entry) && entry.source !== undefined && entry.source !== 'local') throw new Error('Remote environment variables cannot be imported')
        const variable = object(entry) ? entry.name : entry
        if (typeof variable !== 'string') throw new Error('Invalid environment variable name')
        // env_vars is an allow list, not a set of required variables. Unset entries stay unset.
        if (!variables.has(variable) && env[variable] !== undefined) variables.set(variable, env[variable]!)
      }
    }
    server = { name, command: config.command as string, args: (config.args ?? []) as string[], env: [...variables].map(([name, value]) => ({ name, value })) }
  }
  const error = mcpError([server])
  if (error) throw new Error(error)
  return server
}

/** Read-only discovery. Saving a selection is a separate, ordinary settings update. */
export function previewMcpImport(agent: McpImportSource, options: Options = {}): McpImportPreview {
  const home = options.home ?? homedir(), env = options.env ?? process.env
  const result: McpImportPreview = { entries: [], problems: [] }
  const read = (path: string, toml = false): Raw | undefined => {
    try {
      const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
      const data: unknown = toml ? parse(text) : JSON.parse(text)
      if (!object(data)) throw new Error('Expected an object')
      return data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.problems.push(`Could not read ${path}. Check its syntax and permissions.`)
      return undefined
    }
  }
  const add = (servers: unknown, source: string, disabled: unknown = []): void => {
    if (servers === undefined) return
    if (!object(servers)) { result.problems.push(`Invalid MCP server list in ${source}`); return }
    for (const [name, config] of Object.entries(servers)) {
      const base = { id: String(result.entries.length), name, source }
      try {
        if (Array.isArray(disabled) && disabled.includes(name)) throw new Error('Disabled in the source project')
        result.entries.push({ ...base, server: convert(name, config, agent as 'claude' | 'codex', env) })
      } catch (err) { result.entries.push({ ...base, problem: err instanceof Error ? err.message : 'Cannot import this server' }) }
    }
  }
  if (agent === 'gloss') {
    for (const [project, config] of Object.entries(options.legacy ?? {})) {
      for (const server of config.mcpServers ?? []) result.entries.push({ id: String(result.entries.length), name: server.name, source: project, server })
    }
  } else if (agent === 'claude') {
    const configDir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
    const configPath = env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(home, '.claude.json')
    const data = read(configPath)
    add(data?.mcpServers, configPath)
    const projects = new Map<string, Raw>()
    if (object(data?.projects)) {
      for (const [path, config] of Object.entries(data.projects)) if (object(config)) {
        projects.set(path, config)
        add(config.mcpServers, `${configPath} / ${path}`, config.disabledMcpServers)
      }
    }
    for (const path of options.projects ?? []) if (!projects.has(path)) projects.set(path, {})
    const seen = new Set<string>()
    for (const [project, config] of projects) {
      const path = join(project, '.mcp.json')
      const key = process.platform === 'win32' ? path.toLowerCase() : path
      if (seen.has(key)) continue
      seen.add(key)
      add(read(path)?.mcpServers, path, config.disabledMcpjsonServers)
    }
  } else {
    const path = join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml')
    add(read(path, true)?.mcp_servers, path)
    for (const project of new Set(options.projects)) {
      const local = join(project, '.codex', 'config.toml')
      if (local !== path) add(read(local, true)?.mcp_servers, local)
    }
  }
  return result
}
