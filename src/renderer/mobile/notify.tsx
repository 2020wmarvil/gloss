// Notifications on the phone (SPEC → Remote and mobile → Notifications): iOS only gives web push
// to a Home Screen app, so Safari first asks to add Gloss there; the app then asks for permission
// from a tap (the system prompt needs one) and subscribes with the desktop's VAPID key.
import { useEffect, useState } from 'react'
import { Bell, Share, X } from 'lucide-react'
import { errorText } from '../src/errors'
import { link } from './link'

export const isIOS = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
export const standalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
const pushable = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** Subscribes this phone and tells the desktop. Throws if the user or browser refuses. */
export async function subscribe(): Promise<void> {
  const key = await link.invoke('bridge:pushKey') as unknown as string
  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await link.invoke('bridge:subscribe', sub.toJSON())
}

const DISMISSED = 'gloss-notify-dismissed'

export function NotifyCard(): React.JSX.Element | null {
  const [state, setState] = useState<'install' | 'ask' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (localStorage.getItem(DISMISSED)) return
    if (isIOS() && !standalone()) return setState('install')
    if (!pushable()) return
    if (Notification.permission === 'default') setState('ask')
    // Already allowed: keep the desktop's copy of the subscription current.
    else if (Notification.permission === 'granted') void subscribe().catch(() => {})
  }, [])

  if (!state) return null
  const dismiss = (): void => {
    localStorage.setItem(DISMISSED, '1')
    setState(null)
  }
  return (
    <div className="m-card">
      <button className="m-ib sm m-card-x" aria-label="Not now" onClick={dismiss}><X size={14} /></button>
      {state === 'install' ? (
        <>
          <b><Bell size={16} /> Get notifications</b>
          <p>Add Gloss to your Home Screen to hear when a turn finishes or the agent needs you: tap <Share size={14} className="m-ios-share" /> in Safari, then <b>Add to Home Screen</b>, and open Gloss from there.</p>
        </>
      ) : (
        <>
          {error && <p className="m-error" role="alert">{error}</p>}
          <button className="m-btn m-pri m-notify-btn" onClick={() => {
            setError(null)
            void Notification.requestPermission().then(async (p) => {
              if (p !== 'granted') return dismiss()
              await subscribe()
              setState(null)
            }).catch((err: unknown) => setError(errorText(err)))
          }}><Bell size={16} />Turn on notifications</button>
        </>
      )}
    </div>
  )
}
