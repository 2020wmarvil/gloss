/** Persisted in review_base so older Git reviews retain their existing representation. */
export type PerforceRange = { client: string; change: string }
export function perforceRef(client: string, change = 'workspace'): string {
  if (!client || !/^(workspace|default|[1-9][0-9]*)$/.test(change)) throw new Error('Invalid Perforce review selection.')
  return `p4:${encodeURIComponent(client)}:${change}`
}
export function perforceRange(ref: string): PerforceRange | null {
  if (!ref.startsWith('p4:')) return null
  const match = /^p4:([^:]+):(workspace|default|[1-9][0-9]*)$/.exec(ref)
  if (!match) throw new Error('Invalid Perforce review selection.')
  return { client: decodeURIComponent(match[1]), change: match[2] }
}
export function perforceLabel(change: string): string {
  return change === 'workspace' ? 'Workspace' : change === 'default' ? 'Default changelist' : `CL ${change}`
}
export type PerforceWorkspace = { client: string; root: string; stream?: string; user: string; server: string; unicode: boolean }
