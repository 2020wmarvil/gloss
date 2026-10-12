import type { GlossApi } from '../shared/ipc'

declare global {
  interface Window {
    gloss: GlossApi
  }
}
