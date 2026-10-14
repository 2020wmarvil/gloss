import { sameFolder } from './paths'

/** Gloss-managed MCP configuration. Stdio is mandatory in ACP v1; remote transports are negotiated. */
export type McpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers: { name: string; value: string }[] }

export function mcpError(value: unknown): string | null {
  if (!Array.isArray(value)) return 'expected a list of MCP servers'
  const names = new Set<string>()
  for (const [i, item] of value.entries()) {
    const prefix = `server ${i + 1}`
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `${prefix}: expected an object`
    const s = item as Record<string, unknown>
    if (typeof s.name !== 'string' || !s.name.trim()) return `${prefix}: name is required`
    // Codex replaces Unicode whitespace with underscores before configuring servers.
    const name = mcpName(s.name)
    if (names.has(name)) return `${prefix}: duplicate name ${s.name} after replacing whitespace with underscores`
    names.add(name)
    const pairs = (v: unknown): boolean => Array.isArray(v) && v.every((p) =>
      p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim() && typeof p.value === 'string')
    if (s.type === 'http' || s.type === 'sse') {
      try {
        const url = new URL(String(s.url))
        if (!['http:', 'https:'].includes(url.protocol)) return `${prefix}: URL must use HTTP or HTTPS`
      } catch { return `${prefix}: invalid URL` }
      if (!pairs(s.headers)) return `${prefix}: headers must be a list of name/value strings`
    } else if (s.type === undefined) {
      if (typeof s.command !== 'string' || !s.command.trim()) return `${prefix}: command is required`
      if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) return `${prefix}: args must be a list of strings`
      if (!pairs(s.env)) return `${prefix}: env must be a list of name/value strings`
    } else return `${prefix}: transport must be stdio (omit type), http or sse`
  }
  return null
}

export function mcpName(name: string): string { return name.replace(/\p{White_Space}/gu, '_') }

/** Project lookup used by the settings screen. */
export function projectMcp(projects: Record<string, { mcpServers?: McpServer[] }>, cwd: string): McpServer[] {
  const key = Object.keys(projects).find((p) => sameFolder(p, cwd))
  return key ? projects[key].mcpServers ?? [] : []
}

export type McpImportSource = 'claude' | 'codex' | 'gloss'
export type McpImportEntry = { id: string; name: string; source: string; server?: McpServer; problem?: string }
export type McpImportPreview = { entries: McpImportEntry[]; problems: string[] }
