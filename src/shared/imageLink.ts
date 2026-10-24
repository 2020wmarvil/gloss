import { fileLink } from './fileLink'

/** Images may be local absolute paths or paths relative to the session directory. */
export function imageLink(src: string): string | null {
  const absolute = fileLink(src)
  if (absolute) return absolute.path
  let path: string
  try { path = decodeURIComponent(src) } catch { return null }
  if (!path || /[:?#]/.test(path) || /^[\\/]/.test(path) || Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null
  return path
}
