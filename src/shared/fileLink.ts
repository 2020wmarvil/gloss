/** HTML previews open in the browser instead of the configured source editor. */
export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** Parse absolute local Markdown destinations without accepting network paths or other schemes. */
export function fileLink(href: string): { path: string; line: number } | null {
  let path = href
  if (/^file:/i.test(path)) {
    // Only local file URLs, never a host (including UNC shares).
    if (!/^file:\/\/\/(?!\/)/i.test(path)) return null
    path = path.slice(7)
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null
  // Some clients prefix Windows drive paths with a slash.
  path = path.replace(/^\/([a-z]:[\\/])/i, '$1')
  if (!/^(?:[a-z]:[\\/]|\/(?![\\/]))/i.test(path)) return null
  // Exclude Windows device paths and UNC paths, even when slash-prefixed.
  if (path.startsWith('/\\') || path.startsWith('//')) return null
  const position = /(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*))$/.exec(path)
  const line = position ? Number(position[1] ?? position[2]) : 1
  if (!Number.isSafeInteger(line)) return null
  if (position) path = path.slice(0, position.index)
  return { path, line }
}
