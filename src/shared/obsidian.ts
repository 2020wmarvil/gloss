/** Obsidian's built-in URI protocol, restricted to opening a configured vault. */
export function obsidianUri(vault: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault.trim())}`
}
