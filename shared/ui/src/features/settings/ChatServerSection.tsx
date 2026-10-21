// Settings → Chat server (CHAT.md §10.2): address (test / save / change, with same-server detection), sign in or create
// an account, connection status, sessions, sign out, remove. Shared by the web and phone settings pages.
import { useEffect, useId, useState, type FormEvent } from 'react'
import type { ServerInfo, SessionInfo } from '../../../../chat-protocol'
import { chatErrorMessage } from '../../api/chat/client'
import { checkChatUrl, pageIsHttps } from '../../api/chat/url'
import { chatServerApi, useChatServer } from '../../state/chatServer'
import { toast } from '../../state/toast'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'

const REGISTRATION = { closed: 'Accounts are created by the admin', invite: 'Sign-up with an invite code', open: 'Open sign-up' } as const

function EncryptionBadge({ url }: { url: string }) {
  const secure = url.startsWith('https:')
  return <span className={secure ? 'chat-badge chat-badge--ok' : 'chat-badge chat-badge--warn'}>{secure ? 'Encrypted (HTTPS)' : 'Unencrypted'}</span>
}

function InfoRows({ info, url }: { info: ServerInfo; url: string }) {
  return (
    <dl className="rows">
      <div className="rows__row">
        <dt>Server</dt>
        <dd>{info.name}</dd>
      </div>
      <div className="rows__row">
        <dt>Address</dt>
        <dd>
          {url} <EncryptionBadge url={url} />
        </dd>
      </div>
      <div className="rows__row">
        <dt>Version</dt>
        <dd>{info.version}</dd>
      </div>
      <div className="rows__row">
        <dt>Accounts</dt>
        <dd>{REGISTRATION[info.registration]}</dd>
      </div>
    </dl>
  )
}

function AddressForm({ onDone }: { onDone?: () => void }) {
  const saved = useChatServer((s) => s.url)
  const savedInsecure = useChatServer((s) => s.allowInsecure)
  const { probe, saveAddress, switchServer } = useChatServer.getState()
  const [draft, setDraft] = useState(saved ?? '')
  const [insecure, setInsecure] = useState(savedInsecure)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: true; info: ServerInfo; url: string } | { ok: false; text: string } | null>(null)
  const [other, setOther] = useState<{ url: string; info: ServerInfo } | null>(null)
  const https = pageIsHttps()
  const id = useId()

  const checked = () => checkChatUrl(draft, { allowInsecure: insecure, pageIsHttps: https })

  async function test() {
    const c = checked()
    if ('error' in c) return setResult({ ok: false, text: c.error })
    setBusy('test')
    setResult(null)
    try {
      setResult({ ok: true, info: await probe(c.url), url: c.url })
    } catch (e) {
      setResult({ ok: false, text: chatErrorMessage(e, 'connect') })
    }
    setBusy(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const c = checked()
    if ('error' in c) return setResult({ ok: false, text: c.error })
    setBusy('save')
    setResult(null)
    try {
      const r = await saveAddress(c.url, insecure)
      if (typeof r === 'object') setOther({ url: c.url, info: r.otherServer })
      else {
        toast.info(r === 'moved' ? 'Same server, new address. You stay signed in.' : 'Chat server saved on this device.')
        onDone?.()
      }
    } catch (err) {
      setResult({ ok: false, text: chatErrorMessage(err, 'connect') })
    }
    setBusy(null)
  }

  return (
    <form onSubmit={(e) => void save(e)} className="chat-form">
      <label className="field" htmlFor={`${id}-url`}>
        <span>Chat server address</span>
        <input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://chat.example.com"
          value={draft}
          onChange={(e) => (setDraft(e.target.value), setResult(null))}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={insecure && !https} disabled={https} onChange={(e) => (setInsecure(e.target.checked), setResult(null))} />
        <span>Allow unencrypted connection (http:// on my own network)</span>
      </label>
      <p className="hint">
        {https
          ? 'This app is loaded over https://, so only https:// chat servers work here (for example the server’s Tailscale address).'
          : 'Anyone on the same network could read unencrypted traffic. Prefer the server’s https:// address (Tailscale or a domain) when you have one.'}
      </p>
      <div className="actions">
        <button className="btn btn--primary" type="submit" disabled={busy !== null || !draft.trim()}>
          {busy === 'save' ? 'Saving…' : 'Save address'}
        </button>
        <button className="btn" type="button" disabled={busy !== null || !draft.trim()} onClick={() => void test()}>
          {busy === 'test' ? 'Testing…' : 'Test address'}
        </button>
        {onDone && saved && (
          <button className="btn" type="button" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
      {result &&
        (result.ok ? (
          <div role="status">
            <p className="hint">Connected.</p>
            <InfoRows info={result.info} url={result.url} />
          </div>
        ) : (
          <p className="hint chat-error" role="alert">
            {result.text}
          </p>
        ))}
      {other && (
        <ConfirmDialog
          title="Switch to a different chat server?"
          message={`This address is a different chat server (“${other.info.name}”). You’ll be signed out of the current one and its data removed from this device. Your music server, settings and queue aren’t affected.`}
          confirmLabel="Switch server"
          onCancel={() => setOther(null)}
          onConfirm={() => {
            const target = other
            setOther(null)
            void switchServer(target.url, insecure, target.info).then(
              () => (toast.info(`Switched to ${target.info.name}.`), onDone?.()),
              () => toast.error('Couldn’t switch the chat server.'),
            )
          }}
        />
      )}
    </form>
  )
}

function SignInForm({ info }: { info: ServerInfo }) {
  const { signIn, register } = useChatServer.getState()
  const [mode, setMode] = useState<'signin' | 'register'>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [invite, setInvite] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const canRegister = info.registration !== 'closed'
  const registering = mode === 'register' && canRegister

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (registering) await register({ username, password, displayName: displayName.trim() || undefined, inviteCode: info.registration === 'invite' ? invite.trim() : undefined }, remember)
      else await signIn(username, password, remember)
      setPassword('')
    } catch (err) {
      setError(chatErrorMessage(err, 'login'))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="chat-form" aria-label={registering ? 'Create a chat account' : 'Sign in to the chat server'}>
      <p className="hint">Your chat account is separate from your music server account. Use the username and password from this chat server.</p>
      <label className="field">
        <span>Username</span>
        <input autoComplete="username" autoCapitalize="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={32} />
      </label>
      {registering && (
        <label className="field">
          <span>Display name (optional)</span>
          <input autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
        </label>
      )}
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={registering ? 10 : undefined} maxLength={256} />
      </label>
      {registering && info.registration === 'invite' && (
        <label className="field">
          <span>Invite code</span>
          <input autoCapitalize="off" spellCheck={false} value={invite} onChange={(e) => setInvite(e.target.value)} required maxLength={64} />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Keep me signed in on this device</span>
      </label>
      <div className="actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? (registering ? 'Creating…' : 'Signing in…') : registering ? 'Create account' : 'Sign in'}
        </button>
        {canRegister && (
          <button className="btn" type="button" onClick={() => (setMode(registering ? 'signin' : 'register'), setError(''))}>
            {registering ? 'I have an account' : 'Create account'}
          </button>
        )}
      </div>
      {error && (
        <p className="hint chat-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function useCountdown(at: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (at === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [at])
  return at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000))
}

function ConnectionStatus() {
  const c = useChatServer((s) => s.connection)
  const left = useCountdown(c.status === 'reconnecting' ? c.at : null)
  const text = c.status === 'connected' ? 'Connected' : c.status === 'connecting' ? 'Connecting…' : c.status === 'reconnecting' ? (left > 0 ? `Reconnecting in ${left} s` : 'Reconnecting…') : 'Offline'
  return <span className={c.status === 'connected' ? 'chat-badge chat-badge--ok' : 'chat-badge'}>{text}</span>
}

function SessionsDialog({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState('')
  const load = () =>
    chatServerApi()
      ?.sessions()
      .then(setSessions, (e) => setError(chatErrorMessage(e)))
  useEffect(() => void load(), [])
  const act = (op: (() => Promise<unknown>) | undefined) => op?.().then(load, (e) => setError(chatErrorMessage(e)))
  const api = chatServerApi()

  return (
    <Dialog title="Signed-in devices" onClose={onClose}>
      {error && (
        <p className="hint chat-error" role="alert">
          {error}
        </p>
      )}
      {!sessions && !error ? (
        <p className="hint" role="status">
          Loading…
        </p>
      ) : (
        <ul className="chat-members" aria-label="Sessions">
          {sessions?.map((s) => (
            <li key={s.id} className="row">
              <span className="row__text">
                <span className="row__title">
                  {s.deviceName ?? 'Unnamed device'}
                  {s.current && ' (this device)'}
                </span>
                <span className="row__sub">Last used {new Date(s.lastUsedAt).toLocaleString()}</span>
              </span>
              {!s.current && (
                <button type="button" className="link-btn" onClick={() => void act(api ? () => api.revokeSession(s.id) : undefined)}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {sessions && sessions.length > 1 && (
          <button type="button" className="btn btn--danger" onClick={() => void act(api?.revokeOtherSessions)}>
            Sign out all other devices
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} data-autofocus>
          Done
        </button>
      </div>
    </Dialog>
  )
}

function InviteButton() {
  const [code, setCode] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void chatServerApi()
            ?.createInvite(1, 72)
            .then(
              (r) => setCode(r.code),
              (e) => toast.error(chatErrorMessage(e)),
            )
        }
      >
        Create invite code
      </button>
      {code && (
        <p className="hint" role="status">
          Invite code (one use, valid 72 hours, shown once): <code className="chat-code">{code}</code>
        </p>
      )}
    </>
  )
}

export function ChatServerSection() {
  const hydrated = useChatServer((s) => s.hydrated)
  const url = useChatServer((s) => s.url)
  const info = useChatServer((s) => s.info)
  const user = useChatServer((s) => s.user)
  const signedIn = useChatServer((s) => s.token !== null)
  const { signOut, removeServer } = useChatServer.getState()
  const [editing, setEditing] = useState(false)
  const [sessions, setSessions] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  if (!hydrated) return null
  return (
    <div className="chat-settings">
      <p className="hint chat-settings__intro">
        Direct and group messages go through an Auralis chat server. It is separate from your music server and has its own accounts. Messages are stored on it
        unencrypted, so whoever runs it can read them.
      </p>
      {!url || !info || editing ? (
        <AddressForm onDone={url ? () => setEditing(false) : undefined} />
      ) : (
        <>
          <InfoRows info={info} url={url} />
          {signedIn && user ? (
            <>
              <dl className="rows">
                <div className="rows__row">
                  <dt>Signed in as</dt>
                  <dd>
                    {user.displayName} (@{user.username})
                  </dd>
                </div>
                <div className="rows__row">
                  <dt>Status</dt>
                  <dd>
                    <ConnectionStatus />
                  </dd>
                </div>
              </dl>
              <div className="actions">
                <button className="btn" type="button" onClick={() => setSessions(true)}>
                  Devices…
                </button>
                {user.role === 'admin' && <InviteButton />}
                <button className="btn" type="button" onClick={() => void signOut().then(() => toast.info('Signed out of the chat server.'))}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <SignInForm info={info} />
          )}
          <div className="actions">
            <button className="btn" type="button" onClick={() => setEditing(true)}>
              Change address
            </button>
            <button className="btn" type="button" onClick={() => setConfirmRemove(true)}>
              Remove chat server
            </button>
          </div>
        </>
      )}
      {sessions && <SessionsDialog onClose={() => setSessions(false)} />}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove the chat server?"
          message="You’ll be signed out of it and its data removed from this device. Your music server, settings and queue aren’t affected."
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false)
            void removeServer().then(() => toast.info('Chat server removed from this device.'))
          }}
        />
      )}
    </div>
  )
}
