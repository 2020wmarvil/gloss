// Sets the theme on the document: `data-theme` is light or dark, resolved from the
// setting. "System" follows the OS and updates live while the app is open.
import type { ThemeSetting } from '@shared/settings'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

/** Applies `setting` and returns a cleanup that stops following the system. */
export function applyTheme(setting: ThemeSetting): () => void {
  const apply = (): void => {
    document.documentElement.dataset.theme = setting === 'system' ? (systemDark.matches ? 'dark' : 'light') : setting
  }
  apply()
  if (setting !== 'system') return () => {}
  systemDark.addEventListener('change', apply)
  return () => systemDark.removeEventListener('change', apply)
}
