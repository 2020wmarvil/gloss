// Pairing (SPEC → Remote and mobile → Pairing): the QR code opens /pair#<code>. The code stays in
// the fragment, so no server log sees it; the page posts it with the phone's name and the desktop
// answers with the device token in an HttpOnly cookie.
import { useState } from 'react'
import { CircleCheck, Share } from 'lucide-react'
import { errorText } from '../src/errors'
import { isIOS, standalone } from './notify'

function defaultName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Phone'
}

export function Pair({ onDone }: { onDone(): void }): React.JSX.Element {
  const [code] = useState(() => location.hash.slice(1))
  const [name, setName] = useState(defaultName)
  const [state, setState] = useState<'ask' | 'busy' | 'paired'>('ask')
  const [error, setError] = useState<string | null>(null)

  async function pair(): Promise<void> {
    setState('busy')
    setError(null)
    try {
      const res = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) })
      const body = await res.json() as { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'Pairing failed.')
      // The code is used; don't leave it in the address or history.
      history.replaceState(null, '', '/')
      setState('paired')
    } catch (err) {
      setError(errorText(err))
      setState('ask')
    }
  }

  if (state === 'paired') {
    if (isIOS() && !standalone()) {
      return (
        <div className="m-screen m-center">
          <CircleCheck size={44} className="s-done" />
          <h3>Paired</h3>
          <p>Add Gloss to your Home Screen to get notifications when a turn finishes or the agent needs you.</p>
          <div className="m-steps">
            <div><span className="m-num">1</span><span>Tap <Share size={16} className="m-ios-share" /> in Safari's toolbar</span></div>
            <div><span className="m-num">2</span><span>Choose <b>Add to Home Screen</b></span></div>
            <div><span className="m-num">3</span><span>Open <b>Gloss</b> from your Home Screen</span></div>
          </div>
          <button className="m-btn m-ghost" onClick={onDone}>Continue in Safari</button>
        </div>
      )
    }
    onDone()
  }

  return (
    <div className="m-screen m-center">
      <span className="m-bead lg" />
      <h3>Pair with Gloss</h3>
      {!code ? (
        <p>Open this page by scanning the QR code in Gloss's Settings → Phone on the computer.</p>
      ) : (
        <>
          <p>This phone will be able to read your sessions and run your agents.</p>
          <label className="m-flabel" htmlFor="m-name">Name this phone</label>
          <input id="m-name" className="m-field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          {error && <p className="m-error" role="alert">{error}</p>}
          <button className="m-btn m-pri" disabled={state === 'busy' || !name.trim()} onClick={() => void pair()}>Pair</button>
        </>
      )}
    </div>
  )
}
