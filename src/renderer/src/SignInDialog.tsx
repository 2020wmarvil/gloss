import { useState } from 'react'
import type { AuthResult } from '@shared/ipc'
import type { SignInRequest } from './App'

type Props = {
  request: SignInRequest
  onSignIn(methodId: string): Promise<AuthResult>
  onDismiss(): void
}

export function SignInDialog({ request, onSignIn, onDismiss }: Props): React.JSX.Element {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(methodId: string): Promise<void> {
    setPending(methodId)
    setError(null)
    const result = await onSignIn(methodId).catch(
      (err: unknown): AuthResult => ({ ok: false, error: String(err) })
    )
    // On success the main process resolves the request and this dialog closes.
    if (!result.ok) setError(result.error)
    setPending(null)
  }

  const pendingMethod = request.methods.find((m) => m.id === pending)

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="signin-title">
        <h2 id="signin-title">Sign in to {request.agentName}</h2>
        <p className="muted">The agent needs you to sign in before it can continue.</p>
        <ul className="methods">
          {request.methods.map((m) => (
            <li key={m.id}>
              <button onClick={() => void choose(m.id)} disabled={pending !== null}>
                <span className="method-name">{m.name}</span>
                {m.description && <span className="method-desc">{m.description}</span>}
              </button>
            </li>
          ))}
        </ul>
        {pendingMethod && (
          <p className="muted">
            {pendingMethod.kind === 'terminal'
              ? 'Finish signing in in the terminal window that opened.'
              : 'Signing in…'}
          </p>
        )}
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button onClick={onDismiss}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
