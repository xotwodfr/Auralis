import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isAborted } from '../../api/subsonic/errors'
import { useAuth } from '../../state/auth'
import { connectErrorMessage } from './errorMessage'

export default function Connect() {
  const connect = useAuth((s) => s.connect)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)

  useEffect(() => () => pending.current?.abort(), [])

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    pending.current?.abort()
    const controller = (pending.current = new AbortController())
    setBusy(true)
    setError(null)
    try {
      // On success the session guard in App redirects to the library.
      await connect(
        {
          baseUrl: String(form.get('url')),
          username: String(form.get('username')),
          password: String(form.get('password')),
          remember: form.get('remember') === 'on',
        },
        controller.signal,
      )
    } catch (err) {
      if (!isAborted(err)) setError(connectErrorMessage(err))
    } finally {
      if (pending.current === controller) setBusy(false)
    }
  }

  return (
    <main className="shell">
      <section className="shell__panel" aria-labelledby="app-name">
        <h1 id="app-name" className="shell__title">
          Auralis
        </h1>
        <p className="shell__tagline">Connect to your Navidrome or Subsonic server.</p>

        <form className="form" onSubmit={onSubmit} aria-busy={busy}>
          <label className="field">
            <span>Server address</span>
            <input name="url" type="url" inputMode="url" autoComplete="url" autoCapitalize="off" spellCheck={false} placeholder="https://music.example.com" required />
          </label>
          <label className="field">
            <span>Username</span>
            <input name="username" autoComplete="username" autoCapitalize="off" spellCheck={false} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <label className="check">
            <input name="remember" type="checkbox" />
            <span>Remember this device</span>
          </label>
          <p className="hint">Stores your credentials in this browser. Leave off on shared computers.</p>

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}

          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </section>
    </main>
  )
}
