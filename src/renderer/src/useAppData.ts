// What every Gloss window shows besides a session: settings and theme, the agents, the
// message history, sign-in requests and the full-screen hint.
import { useCallback, useEffect, useState } from 'react'
import type { GlossEvent, SettingsPatch, SettingsState } from '@shared/ipc'
import type { AgentInfo, AuthMethodInfo } from '@shared/types'
import { CAPTURE } from './Composer'
import { applyTheme } from './theme'

export type SignInRequest = { agentId: string; agentName: string; methods: AuthMethodInfo[] }

export function useAppData() {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  /** Messages sent in every session, newest first, each once (SPEC → Composer → History). */
  const [sent, setSent] = useState<string[]>([])
  const [signIn, setSignIn] = useState<SignInRequest | null>(null)
  /** Counts entries into full screen; each shows the hint on how to leave again. */
  const [fullScreenHint, setFullScreenHint] = useState(0)

  useEffect(() => {
    void window.gloss.settings.get().then(setSettings)
    void window.gloss.history().then(setSent)
    void window.gloss.agents.list().then(setAgents)
  }, [])

  useEffect(
    () =>
      window.gloss.onEvent((event: GlossEvent) => {
        switch (event.type) {
          case 'agents':
            setAgents(event.agents)
            break
          case 'message': {
            const { role, text } = event.message
            if (role === 'user' && text) setSent((h) => (h[0] === text ? h : [text, ...h.filter((t) => t !== text)]))
            break
          }
          case 'fullScreen':
            setFullScreenHint((n) => n + 1)
            break
          case 'captureShortcut':
            // The capture shortcut, in Gloss or another app: the composer used last takes the capture.
            window.dispatchEvent(new Event(CAPTURE))
            break
          case 'authRequired':
            setSignIn({ agentId: event.agentId, agentName: event.agentName, methods: event.methods })
            break
          case 'authResolved':
            setSignIn((s) => (s?.agentId === event.agentId ? null : s))
            break
          case 'settings':
            setSettings(event.state)
            void window.gloss.agents.list().then(setAgents)
            break
        }
      }),
    []
  )

  const theme = settings?.global.theme ?? 'system'
  useEffect(() => applyTheme(theme), [theme])

  const updateSettings = useCallback(async (patch: SettingsPatch): Promise<void> => {
    setSettings(await window.gloss.settings.update(patch))
    if (patch.global && ('opencodeExecutable' in patch.global || 'agentProfiles' in patch.global)) setAgents(await window.gloss.agents.list())
  }, [])

  return { settings, agents, sent, signIn, fullScreenHint, updateSettings }
}
