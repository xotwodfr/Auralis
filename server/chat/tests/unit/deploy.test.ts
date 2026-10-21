// Deployment invariants (CHAT.md §7.10): the database is never published, containers stay locked down, no secrets in
// the repository's examples, no code path that disables certificate checks.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../../', import.meta.url).pathname
const read = (f: string) => readFileSync(join(root, f), 'utf8')

/** The indented block of one top-level service in compose.yaml. */
function service(name: string): string {
  const lines = read('compose.yaml').split('\n')
  const start = lines.findIndex((l) => l === `  ${name}:`)
  expect(start, `service ${name}`).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('compose.yaml', () => {
  it('never publishes PostgreSQL and keeps it on an internal-only network', () => {
    const db = service('db')
    expect(db).not.toMatch(/^\s+ports:/m)
    expect(db).toMatch(/networks: \[internal\]/)
    expect(read('compose.yaml')).toMatch(/internal: \{ internal: true \}/)
    expect(db).toMatch(/POSTGRES_PASSWORD_FILE/)
    expect(db).not.toMatch(/POSTGRES_PASSWORD:/)
    // PostgreSQL 18 keeps data under /var/lib/postgresql/18/docker; the old .../data mount would lose it on recreate.
    expect(db).toMatch(/db-data:\/var\/lib\/postgresql\]/)
  })

  it('binds the app to loopback by default and locks the containers down', () => {
    const chat = service('chat')
    expect(chat).toMatch(/\$\{CHAT_BIND_ADDRESS:-127\.0\.0\.1\}/)
    for (const s of [chat, service('migrate')]) {
      expect(s).toMatch(/read_only: true/)
      expect(s).toMatch(/cap_drop: \[ALL\]/)
      expect(s).toMatch(/no-new-privileges:true/)
    }
    expect(chat).toMatch(/condition: service_completed_successfully/)
  })

  it('the image runs as node with no dev dependencies, tests or env files', () => {
    const dockerfile = read('Dockerfile')
    expect(dockerfile).toMatch(/^USER node$/m)
    expect(dockerfile).toMatch(/npm ci --omit=dev/)
    expect(read('.dockerignore').split('\n')).toEqual(expect.arrayContaining(['tests', '.env', 'secrets', 'node_modules']))
  })
})

describe('repository hygiene', () => {
  it('.env.example has no secrets and only refuses-safe defaults', () => {
    const env = read('.env.example')
    expect(env).not.toMatch(/PASSWORD=|SECRET=|TOKEN=/i)
    expect(env).toMatch(/^CHAT_REGISTRATION=closed$/m)
    expect(env).toMatch(/^CHAT_TRUST_PROXY=0$/m)
    expect(env).toMatch(/^CHAT_BIND_ADDRESS=127\.0\.0\.1$/m)
    expect(env).not.toMatch(/^CHAT_ALLOWED_ORIGINS=.*\*/m)
  })

  it('no source or test disables certificate validation', () => {
    const files = (dir: string): string[] =>
      readdirSync(join(root, dir)).flatMap((f) => (statSync(join(root, dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
    const banned = ['rejectUnauthorized: false', 'NODE_TLS_REJECT_UNAUTHORIZED']
    for (const f of [...files('src'), ...files('scripts')]) for (const b of banned) expect(read(f), f).not.toContain(b)
  })
})
