/** What Mod reads as on this platform. */
export function modKey(userAgent: string = navigator.userAgent): string {
  return /Mac/.test(userAgent) ? 'Cmd' : 'Ctrl'
}
