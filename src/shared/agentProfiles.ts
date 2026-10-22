export type AgentProfile = {
  id: string
  name: string
  command: string
  args: string[]
  /** Child variable name -> inherited variable name, never a credential value. */
  env: Record<string, string>
  /** An agent-specific variable accepting the instruction file's absolute path. */
  instructionsEnv?: string
}

export const PROFILE_ID = /^custom:[a-z0-9][a-z0-9-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function profileError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Expected an agent profile.'
  const p = value as Record<string, unknown>
  if (typeof p.id !== 'string' || !PROFILE_ID.test(p.id)) return 'ID must be custom: followed by lowercase letters, digits or hyphens.'
  if (typeof p.name !== 'string' || !p.name.trim()) return 'Enter a display name.'
  if (typeof p.command !== 'string' || !p.command.trim() || /[\r\n\0]/.test(p.command)) return 'Enter an executable path or name.'
  if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string' || a.includes('\0'))) return 'Arguments must be a JSON array of strings.'
  if (!p.env || typeof p.env !== 'object' || Array.isArray(p.env) || Object.entries(p.env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== 'string' || !ENV_NAME.test(v))) return 'Environment references must map variable names to inherited variable names.'
  if (p.instructionsEnv !== undefined && (typeof p.instructionsEnv !== 'string' || !ENV_NAME.test(p.instructionsEnv))) return 'The instruction environment variable must be a variable name.'
  if (!p.instructionsEnv && !p.args.some((a: string) => a.includes('{instructions}'))) return 'Use {instructions} in an instruction-file argument, or provide an instruction environment variable.'
  if (p.instructionsEnv && Object.keys(p.env).some((k) => k.toLowerCase() === String(p.instructionsEnv).toLowerCase())) return 'The instruction variable must not also be an environment reference.'
  return null
}

export function profilesError(value: unknown): string | null {
  if (!Array.isArray(value)) return 'Expected an array of agent profiles.'
  const ids = new Set<string>()
  for (const p of value) {
    const error = profileError(p)
    if (error) return error
    if (ids.has(p.id)) return 'Agent profile IDs must be unique.'
    ids.add(p.id)
  }
  return null
}
