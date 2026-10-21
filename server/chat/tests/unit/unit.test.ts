import { describe, expect, it } from 'vitest'
import { checkPassword, cleanDisplayName, normalizeUsername } from '../../src/auth.ts'
import { ConfigError, loadConfig } from '../../src/config.ts'
import { can, type Action } from '../../src/conversations.ts'
import { hashPassword, newToken, sha256, TOKEN_SHAPE, verifyPassword } from '../../src/crypto.ts'
import { clientAddress, limiter } from '../../src/http.ts'
import { cleanBody } from '../../src/messages.ts'

const DB = { DATABASE_URL: 'postgres://u:p@localhost/x' }

describe('config', () => {
  it('has safe defaults', () => {
    const { config } = loadConfig(DB)
    expect(config).toMatchObject({ registration: 'closed', listenHost: '127.0.0.1', trustProxy: false, allowedOrigins: [], port: 8790 })
  })

  it.each([
    [{ CHAT_ALLOWED_ORIGINS: '*' }, /exact origin/],
    [{ CHAT_ALLOWED_ORIGINS: 'null' }, /exact origin/],
    [{ CHAT_ALLOWED_ORIGINS: 'https://a.test/' }, /exact origin/],
    [{ CHAT_ALLOWED_ORIGINS: 'https://*.test' }, /exact origin/],
    [{ CHAT_TRUST_PROXY: '1', CHAT_BIND_ADDRESS: '192.168.1.20' }, /loopback/],
    [{ CHAT_TRUST_PROXY: 'yes' }, /0, 1 or cloudflare/],
    [{ CHAT_TRUST_PROXY: 'cloudflare', CHAT_BIND_ADDRESS: '0.0.0.0' }, /loopback/],
    [{ CHAT_REGISTRATON: 'open' }, /Unknown setting/],
    [{ CHAT_REGISTRATION: 'public' }, /closed, invite or open/],
    [{ CHAT_PORT: '0' }, /CHAT_PORT/],
    [{ CHAT_MAX_MESSAGE_CHARS: '5000' }, /CHAT_MAX_MESSAGE_CHARS/],
    [{ CHAT_SESSION_IDLE_DAYS: '90', CHAT_SESSION_MAX_DAYS: '30' }, /cannot exceed/],
  ])('refuses %o', (env, message) => {
    expect(() => loadConfig({ ...DB, ...env })).toThrow(message)
  })

  it('needs a database and refuses an unreadable or empty password file', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({ DATABASE_PASSWORD_FILE: '/nonexistent/secret' })).toThrow(/cannot be read/)
    expect(() => loadConfig({ DATABASE_PASSWORD_FILE: '/dev/null' })).toThrow(/is empty/)
  })

  it('accepts custom-scheme origins and loopback proxy trust, and warns about open public sign-up', () => {
    const { config, warnings } = loadConfig({ ...DB, CHAT_ALLOWED_ORIGINS: 'tauri://localhost, http://tauri.localhost,https://chat.example', CHAT_TRUST_PROXY: '1', CHAT_REGISTRATION: 'open' })
    expect(config.allowedOrigins).toEqual(['tauri://localhost', 'http://tauri.localhost', 'https://chat.example'])
    expect(warnings).toHaveLength(1)
    expect(config.trustProxy).toBe('forwarded')
    expect(loadConfig({ ...DB, CHAT_TRUST_PROXY: 'cloudflare' }).config.trustProxy).toBe('cloudflare')
  })
})

describe('client address', () => {
  const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as never
  const spoofed = { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }

  it('uses the socket address unless a proxy is trusted', () => {
    expect(clientAddress(req(spoofed), false)).toBe('127.0.0.1')
  })

  it('behind a plain proxy, takes only the hop that proxy appended and ignores a caller-sent CF-Connecting-IP', () => {
    expect(clientAddress(req(spoofed), 'forwarded')).toBe('203.0.113.9')
  })

  it('behind Cloudflare, takes CF-Connecting-IP', () => {
    expect(clientAddress(req(spoofed), 'cloudflare')).toBe('6.6.6.6')
  })
})

describe('passwords and tokens', () => {
  it('round-trips, rejects wrong passwords and flags weaker parameters for upgrade', async () => {
    const stored = await hashPassword('correct horse battery', 10)
    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$/)
    expect(stored).not.toContain('correct horse')
    expect(await verifyPassword('correct horse battery', stored, 10)).toEqual({ ok: true, upgrade: false })
    expect(await verifyPassword('correct horse batterz', stored, 10)).toEqual({ ok: false, upgrade: false })
    expect(await verifyPassword('correct horse battery', stored, 11)).toEqual({ ok: true, upgrade: true })
    expect(await verifyPassword('x', 'bcrypt$whatever', 10)).toEqual({ ok: false, upgrade: false })
  })

  it('normalises to NFC before hashing', async () => {
    const stored = await hashPassword('café au lait!!', 10)
    expect((await verifyPassword('café au lait!!', stored, 10)).ok).toBe(true)
  })

  it('tokens are prefixed, random and only their hash is meant to be stored', () => {
    const a = newToken()
    expect(a).toMatch(TOKEN_SHAPE)
    expect(newToken()).not.toBe(a)
    expect(sha256(a)).toHaveLength(32)
  })

  it('validates usernames, passwords and display names', () => {
    expect(normalizeUsername(' Alex.B ')).toBe('alex.b')
    expect(() => normalizeUsername('ab')).toThrow()
    expect(() => normalizeUsername('a b c')).toThrow()
    expect(() => checkPassword('short', 'alex')).toThrow(/10–256/)
    expect(() => checkPassword('alexalexalex', 'alexalexalex')).toThrow(/username/)
    expect(cleanDisplayName('  Alex \n\t B\u202e ')).toBe('Alex B')
    expect(() => cleanDisplayName('\u0000')).toThrow()
  })
})

describe('permissions (CHAT.md §7.5)', () => {
  const cases: [Action, 'direct' | 'group', 'owner' | 'admin' | 'member', object, boolean][] = [
    ['rename', 'direct', 'member', {}, false],
    ['rename', 'group', 'member', {}, false],
    ['rename', 'group', 'admin', {}, true],
    ['rename', 'group', 'owner', {}, true],
    ['addMembers', 'direct', 'owner', {}, false],
    ['addMembers', 'group', 'member', {}, false],
    ['addMembers', 'group', 'admin', {}, true],
    ['removeMember', 'direct', 'member', { self: true }, false],
    ['removeMember', 'group', 'member', { self: true }, true],
    ['removeMember', 'group', 'member', { target: 'member' }, false],
    ['removeMember', 'group', 'admin', { target: 'member' }, true],
    ['removeMember', 'group', 'admin', { target: 'owner' }, false],
    ['removeMember', 'group', 'owner', { target: 'admin' }, true],
    ['deleteMessage', 'direct', 'member', { sender: true }, true],
    ['deleteMessage', 'direct', 'member', { sender: false }, false],
    ['deleteMessage', 'group', 'member', { sender: false }, false],
    ['deleteMessage', 'group', 'admin', { sender: false }, true],
  ]
  it.each(cases)('%s in %s as %s %o → %s', (action, kind, role, extra, expected) => {
    expect(can(action, kind, role, extra)).toBe(expected)
  })
})

describe('message bodies', () => {
  it('keeps text, strips control characters, caps blank lines and enforces length in code points', () => {
    expect(cleanBody('  hi\u0007 there\r\n\n\n\n\nbye\t!  ', 4000)).toBe('hi there\n\n\nbye\t!')
    expect(cleanBody('😀'.repeat(4000), 4000)).toHaveLength(8000)
    expect(() => cleanBody('😀'.repeat(4001), 4000)).toThrow(/at most 4000/)
    expect(() => cleanBody(' \u0000\n ', 4000)).toThrow(/empty/)
  })
})

describe('limiter', () => {
  it('allows max hits per window and reports the wait', () => {
    let t = 0
    const l = limiter(2, 10_000, () => t)
    expect([l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([0, 0, 10])
    expect(l.hit('b')).toBe(0)
    t = 9_500
    expect(l.check('a')).toBe(1)
    t = 10_001
    expect(l.hit('a')).toBe(0)
    l.reset('a')
    expect(l.check('a')).toBe(0)
  })
})
