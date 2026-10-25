/** A mention at the caret, including quoted paths containing spaces. */
export function composerMention(text: string, caret: number): { query: string; start: number; end: number } | null {
  const match = /(?:^|\s)@(?:"([^"\r\n]*)"?|([^\s@"]*))$/.exec(text.slice(0, caret))
  if (!match) return null
  return { query: match[1] ?? match[2], start: match.index + (match[0].startsWith('@') ? 0 : 1), end: caret }
}

export function mentionPrefix(path: string): string {
  return `@${/\s/.test(path) ? '"' : ''}${path}`
}
