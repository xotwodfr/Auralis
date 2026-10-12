import { expect, test, type Page } from '@playwright/test'

const MOCK = 'http://127.0.0.1:4599'
const APP = 'http://127.0.0.1:5199'
const FAKE_KEY = 'e2e-fake-secret'
const SPOTIFY_URL = 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA?si=e2e'

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
})

async function playLineDancer(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.getByRole('link', { name: 'Now Playing', exact: true }).click()
}

test('Spicy Lyrics: link a track, see word-timed lyrics with attribution, and the key never reaches the browser', async ({ page, request }) => {
  const leaks: string[] = []
  const apiRequests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('spicylyrics')) leaks.push(`browser called Spicy Lyrics directly: ${r.url()}`)
    if (r.url().includes('/api/spicy/')) {
      if (r.url().includes('/api/spicy/lyrics/')) apiRequests.push(new URL(r.url()).pathname)
      if ('authorization' in r.headers()) leaks.push('browser sent an Authorization header to /api/spicy')
    }
  })
  page.on('response', async (r) => {
    const type = r.headers()['content-type'] ?? ''
    if (!/json|javascript|html|css/.test(type)) return
    const body = await r.text().catch(() => '')
    if (body.includes(FAKE_KEY)) leaks.push(`secret in response body of ${r.url()}`)
    if (JSON.stringify(r.headers()).includes(FAKE_KEY)) leaks.push(`secret in response headers of ${r.url()}`)
  })

  await playLineDancer(page)
  const lyrics = page.getByRole('region', { name: 'Lyrics' })
  // This track has no Spotify match, so before linking, lyrics come from the server (line-level).
  await expect(lyrics.getByRole('button', { name: 'Line one' })).toBeVisible()
  expect(apiRequests).toEqual([])

  await page.getByText(/Word-synced lyrics/).click()
  await page.getByLabel('Spotify track link').fill('https://example.com/not-spotify')
  await page.getByRole('button', { name: 'Link track' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Spotify track link' })).toBeVisible()
  await page.getByLabel('Spotify track link').fill(SPOTIFY_URL)
  await page.getByRole('button', { name: 'Link track' }).click()

  const line = lyrics.getByRole('button', { name: 'Hello wonderful world' })
  await expect(line).toBeVisible()
  await expect(page.getByText(/Lyrics from Spicy Lyrics \(via Spicy Lyrics\)/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Una' })).toHaveAttribute('href', 'https://spicylyrics.org/uid/1')
  await expect(page.getByRole('link', { name: 'Mo' })).toHaveAttribute('href', 'https://spicylyrics.org/uid/2')

  // Playback advances the highlight word by word (the audio really plays in this browser).
  await expect(line.locator('.syl.is-active')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => line.locator('.syl.is-done').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Hello wonderful world' })).toBeVisible() // link and cache survive a reload

  expect(apiRequests).toEqual(['/api/spicy/lyrics/AAAAAAAAAAAAAAAAAAAAAA']) // cached after the first fetch
  const stats = await (await request.get(`${MOCK}/__stats`)).json()
  expect(stats['spicy-upstream']).toBe(1) // the backend reached the (fake) upstream once, with the right key
  expect(stats['spicy-upstream-unauthorized'] ?? 0).toBe(0)
  expect(leaks).toEqual([])

  // …and the key is absent from the shipped JavaScript.
  const html = await (await request.get(APP)).text()
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!)
  expect(assets.length).toBeGreaterThan(0)
  for (const a of assets) expect(await (await request.get(APP + a)).text()).not.toContain(FAKE_KEY)
})

test('the backend endpoint is narrow: validated ids, GET only, same-site only', async ({ request }) => {
  const api = (path: string, init: Parameters<typeof request.fetch>[1] = {}) => request.fetch(APP + path, { failOnStatusCode: false, ...init })
  expect((await api('/api/spicy/health')).status()).toBe(200)
  expect(await (await api('/api/spicy/health')).json()).toEqual({ enabled: true, matching: true })
  expect((await api('/api/spicy/match?title=x&q=free-form')).status()).toBe(400) // not a general search proxy
  expect((await api('/api/spicy/match?title=x', { headers: { origin: 'https://evil.test' } })).status()).toBe(403)
  expect((await api('/api/spicy/lyrics/not-an-id')).status()).toBe(400)
  expect((await api('/api/spicy/lyrics/..%2F..%2Fetc')).status()).toBe(400)
  expect((await api('/api/spicy/keys')).status()).toBe(404)
  expect((await api('/api/spicy/lyrics/AAAAAAAAAAAAAAAAAAAAAA', { method: 'POST' })).status()).toBe(405)
  expect((await api('/api/spicy/lyrics/AAAAAAAAAAAAAAAAAAAAAA', { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403)
  expect((await api('/api/spicy/lyrics/AAAAAAAAAAAAAAAAAAAAAA', { headers: { origin: 'https://evil.test' } })).status()).toBe(403)
  expect((await api('/api/spicy/lyrics/BBBBBBBBBBBBBBBBBBBBBB')).status()).toBe(404) // upstream "no lyrics"
  const ok = await api('/api/spicy/lyrics/AAAAAAAAAAAAAAAAAAAAAA')
  expect(ok.status()).toBe(200)
  expect(await ok.text()).not.toContain(FAKE_KEY)
})
