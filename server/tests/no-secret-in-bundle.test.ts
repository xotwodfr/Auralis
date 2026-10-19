/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const at = (...p: string[]) => join(repo, ...p)

// Every platform that ships frontend code: its sources, and the bundle it builds (when one has been built).
const SOURCES = ['shared/ui/src', 'web/src', 'tauri/frontend', 'android/frontend'].map((d) => at(d))
const BUNDLES = ['web/dist', 'tauri/frontend/dist', 'android/frontend/dist'].map((d) => at(d))

// The Spicy Lyrics key and the Spotify client secret must exist only in the Node process. These guard the three ways
// they could reach the browser.
function filesIn(dir: string, skip: string[] = []): string[] {
  return readdirSync(dir)
    .filter((f) => !skip.includes(f))
    .flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesIn(join(dir, f), skip) : [join(dir, f)]))
}

describe('the secret key stays server-side', () => {
  it('is not visible to client code through import.meta.env', () => {
    expect(Object.keys(import.meta.env).filter((k) => /SPICY|SPOTIFY|SECRET/i.test(k))).toEqual([])
  })

  it('no frontend source reads it or contains a key', () => {
    const offenders = SOURCES.flatMap((d) => filesIn(d, ['dist'])).filter((f) => /sl_sk_|VITE_SPICY|VITE_SPOTIFY|import\.meta\.env\.\w*(SPICY|SPOTIFY|SECRET)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('is not in any production bundle (when one has been built)', () => {
    const offenders = BUNDLES.filter((d) => existsSync(d)).flatMap((d) => filesIn(d)).filter((f) => /sl_sk_|api\.spicylyrics\.org|accounts\.spotify\.com|api\.spotify\.com|Bearer |Basic /.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('.env files are git-ignored (only .env.example may be committed)', () => {
    const ignore = readFileSync(at('.gitignore'), 'utf8').split('\n')
    expect(ignore).toEqual(expect.arrayContaining(['.env', '.env.*', '!.env.example']))
    const example = readFileSync(at('.env.example'), 'utf8')
    expect(example).toMatch(/^SPICY_LYRICS_SECRET_KEY=$/m) // placeholders, never values
    expect(example).toMatch(/^SPOTIFY_CLIENT_ID=$/m)
    expect(example).toMatch(/^SPOTIFY_CLIENT_SECRET=$/m)
  })
})
