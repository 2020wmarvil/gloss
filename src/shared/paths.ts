// Folder path helpers usable in the renderer (no Node `path` there).

/** Whether two folder paths look like the same folder: slashes and a trailing separator ignored, case too for Windows paths. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const windows = /^[a-zA-Z]:|\\/.test(p)
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return windows ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/** The last segment of a folder path. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
