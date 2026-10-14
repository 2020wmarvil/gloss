export type SearchRequest = {
  query: string
  scope: 'session' | 'project' | 'all'
  sessionId?: string
  cwd?: string
  kind: 'all' | 'user' | 'agent' | 'tool'
}

export type SearchResult = {
  id: string
  sessionId: string
  sessionTitle: string
  cwd: string
  threadId: string | null
  threadQuote: string | null
  kind: 'user' | 'agent' | 'tool'
  /** Plain text with U+0001/U+0002 around matches. Never HTML. */
  snippet: string
}

export type SearchResponse = { results: SearchResult[]; more: boolean }
