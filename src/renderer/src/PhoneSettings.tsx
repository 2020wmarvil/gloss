// Settings → Phone (SPEC → Remote and mobile; docs/mocks/mobile.html section 6): phone access over
// Tailscale, pairing with a one-time QR code, and the paired phones with their last use and Remove.
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Copy, Smartphone } from 'lucide-react'
import type { PhoneStatus } from '@shared/ipc'
import { errorText } from './errors'
import { Switch } from './Select'

type Props = { on: boolean; port: number; onUpdate(values: { phoneAccess?: boolean; phonePort?: number }): Promise<void> }

export function PhoneSettings({ on, port, onUpdate }: Props): React.JSX.Element {
  const [status, setStatus] = useState<PhoneStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [portDraft, setPortDraft] = useState(String(port))
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void window.gloss.phone.status().then(setStatus)
    return window.gloss.onEvent((e) => { if (e.type === 'phone') setStatus(e.status) })
  }, [])
  useEffect(() => setPortDraft(String(port)), [port])
  // The pairing code's countdown.
  useEffect(() => {
    if (!status?.pairing) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [status?.pairing])

  const run = (p: Promise<PhoneStatus | void>): void => {
    setError(null)
    void p.then((s) => { if (s) setStatus(s) }).catch((err: unknown) => setError(errorText(err)))
  }
  const savePort = (): void => {
    const n = Number(portDraft)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setError('Choose a port from 1024 to 65535.')
      setPortDraft(String(port))
      return
    }
    if (n !== port) run(onUpdate({ phonePort: n }))
  }
  const left = status?.pairing ? Math.max(0, Math.ceil((status.pairing.expiresAt - now) / 1000)) : 0

  return (
    <>
      <p className="settings-hint">
        Use Gloss from your phone while this computer runs the agents.
      </p>
      <div className="settings-card">
        <div className="setting">
          <div className="setting-copy">
            <label className="setting-label" htmlFor="setting-phoneAccess">Allow phones to connect</label>
            <p className="setting-desc" id="setting-phoneAccess-description">
              {status?.origin ? `Over Tailscale only, at ${status.origin}` : 'Over Tailscale only. Nothing listens until this is on.'}
            </p>
          </div>
          <Switch id="setting-phoneAccess" ariaLabel="Allow phones to connect" ariaDescribedBy="setting-phoneAccess-description" checked={on} onChange={(v) => run(onUpdate({ phoneAccess: v }))} />
        </div>
        <div className="setting">
          <div className="setting-copy">
            <label className="setting-label" htmlFor="setting-phonePort">Port</label>
            <p className="setting-desc">The port phones connect to.</p>
          </div>
          <input
            id="setting-phonePort"
            className="phone-port"
            inputMode="numeric"
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, ''))}
            onBlur={savePort}
            onKeyDown={(e) => { if (e.key === 'Enter') savePort(); if (e.key === 'Escape') setPortDraft(String(port)) }}
          />
        </div>
      </div>

      {on && status && (
        <div className="phone-checks" role="status">
          {status.state === 'starting' && <div className="phone-check">Checking Tailscale and getting the certificate…</div>}
          {status.state === 'on' && (
            <>
              <div className="phone-check"><CircleCheck className="ok" />Tailscale is running as {status.machine}</div>
              {status.certExpiresAt && <div className="phone-check"><CircleCheck className="ok" />HTTPS certificate valid until {new Date(status.certExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, renewed automatically</div>}
              {status.certWarning && <div className="phone-check"><CircleAlert className="bad" />{status.certWarning}</div>}
              <div className="phone-check"><CircleCheck className="ok" />Listening on {status.ip} only</div>
            </>
          )}
          {status.state === 'error' && (
            <>
              <div className="phone-check"><CircleAlert className="bad" />{status.error}</div>
              <button className="secondary sm" onClick={() => run(window.gloss.phone.retry())}>Try again</button>
            </>
          )}
        </div>
      )}
      {error && <p className="settings-problem" role="alert">{error}</p>}

      {status?.state === 'on' && (
        status.pairing ? (
          <div className="phone-pair">
            <img className="phone-qr" src={status.pairing.qr} alt="Pairing QR code" />
            <div className="phone-pair-text">
              <strong>Scan with your phone's camera</strong>
              <span>The phone needs Tailscale, signed in to the same tailnet. On iPhone, add Gloss to the Home Screen when asked, for notifications.</span>
              <span className="mono phone-addr">{status.origin?.replace(/^https:\/\//, '')}/pair</span>
              <span className="phone-expiry">This code works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</span>
              <span className="phone-pair-actions">
                <button className="secondary sm" onClick={() => void navigator.clipboard.writeText(status.pairing!.url)}><Copy />Copy link</button>
                <button className="ghost sm" onClick={() => run(window.gloss.phone.cancelPairing())}>Cancel</button>
              </span>
            </div>
          </div>
        ) : (
          <button className="primary phone-pair-button" onClick={() => run(window.gloss.phone.pair())}>Pair a phone</button>
        )
      )}

      {status && status.devices.length > 0 && (
        <>
          <h3 className="phone-devices-title">Paired phones</h3>
          <div className="settings-card">
            {status.devices.map((d) => (
              <div className="setting phone-device" key={d.id}>
                <Smartphone className="phone-device-icon" />
                <div className="setting-copy">
                  <span className="setting-label">{d.name}</span>
                  <p className="setting-desc">
                    Paired {new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · notifications {d.notifications ? 'on' : 'off'}
                  </p>
                </div>
                {d.connected ? <span className="phone-live">Connected</span>
                  : <span className="setting-desc">{d.lastUsedAt ? `Last used ${ago(d.lastUsedAt)}` : 'Not used yet'}</span>}
                <button className="ghost sm phone-remove" onClick={() => run(window.gloss.phone.removeDevice(d.id))}>Remove</button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function ago(at: number): string {
  const d = Date.now() - at
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`
  const days = Math.floor(d / 86_400_000)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
