import { expect, test, type Page } from '@playwright/test'

// Automatic Spotify matching and the word-synced lyrics stage, against the production build. The backend runs with
// fake Spicy Lyrics and Spotify credentials pointed at local stand-ins in e2e/mock-server.mjs.
const MOCK = 'http://127.0.0.1:4599'
const APP = 'http://127.0.0.1:5199'
const SECRETS = ['e2e-fake-secret', 'e2e-spotify-secret', 'e2e-spotify-access-token']

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
})

async function play(page: Page, title: string, album = 'al1') {
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
  await page.goto(`/library/albums/${album}`)
  await page.getByRole('button', { name: `Play ${title}`, exact: true }).click()
  await expect(page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.getByRole('link', { name: 'Now Playing', exact: true }).click()
}

test('an ordinary track is matched automatically: Navidrome track → Spotify id → Spicy Lyrics → word-synced lyrics', async ({ page, request }) => {
  const leaks: string[] = []
  const calls: string[] = []
  page.on('request', (r) => {
    if (/spotify\.com|spicylyrics\.org/.test(r.url())) leaks.push(`browser called a third party directly: ${r.url()}`)
    if (r.url().includes('/api/spicy/')) calls.push(new URL(r.url()).pathname)
  })
  page.on('response', async (r) => {
    const body = /json|javascript|html|css/.test(r.headers()['content-type'] ?? '') ? await r.text().catch(() => '') : ''
    for (const s of SECRETS) if (body.includes(s) || JSON.stringify(r.headers()).includes(s)) leaks.push(`${s} in response from ${r.url()}`)
  })

  await play(page, 'Quiet Hours')
  const lyrics = page.getByRole('region', { name: 'Lyrics' })
  await expect(lyrics.getByRole('button', { name: 'I count the lights' })).toBeVisible()
  await expect(page.getByText('Lyrics from Apple Music (via Spicy Lyrics)')).toBeVisible()
  await expect(page.getByText(/Word-synced lyrics \(Spicy Lyrics\) · matched automatically/)).toBeAttached()
  expect(calls).toEqual(expect.arrayContaining(['/api/spicy/health', '/api/spicy/match', '/api/spicy/lyrics/QQQQQQQQQQQQQQQQQQQQQQ']))

  // The highlight follows the audio clock: the sung syllable's painted progress agrees with the player's time.
  await expect(lyrics.locator('.syl.is-active')).toHaveCount(1, { timeout: 10_000 })
  const sample = await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('.syl.is-active')!
    const p = Number(s.style.getPropertyValue('--p'))
    const t = Number(s.dataset.start) + p * (Number(s.dataset.end) - Number(s.dataset.start))
    const slider = document.querySelector<HTMLInputElement>('.player .progress input[type="range"]')!
    return { painted: t, player: Number(slider.value) }
  })
  expect(Math.abs(sample.painted - sample.player)).toBeLessThan(1) // the slider itself only updates ~4×/s

  // The backend caches matches and its token in memory (earlier specs may have warmed it), so prove the upstream path
  // with a query it has not seen: it reaches the Spotify stand-in with valid credentials and returns only match fields.
  await request.get(`${MOCK}/__reset`)
  const fresh = await request.get(`${APP}/api/spicy/match?title=${encodeURIComponent(`Quiet Hours ${Date.now()}`)}&artist=Artist%20A`)
  expect((await fresh.json()).candidates[0].id).toBe('QQQQQQQQQQQQQQQQQQQQQQ')
  const stats = await (await request.get(`${MOCK}/__stats`)).json()
  expect(stats['spotify-search']).toBe(1)
  expect(stats['spotify-token-unauthorized'] ?? 0).toBe(0)

  // Cached: a reload does not search Spotify again.
  calls.length = 0
  await page.reload()
  await expect(page.getByRole('region', { name: 'Lyrics' }).getByRole('button', { name: 'I count the lights' })).toBeVisible()
  expect(calls).not.toContain('/api/spicy/match')

  for (const a of [...(await (await request.get(APP)).text()).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!)) {
    const text = await (await request.get(APP + a)).text()
    for (const s of SECRETS) expect(text).not.toContain(s)
  }
  expect(leaks).toEqual([])
})

test('ambiguous recordings: no guess, a keyboard-accessible choice, then word-synced lyrics', async ({ page }) => {
  await play(page, 'Fourth Song', 'al2')
  const chooser = page.getByRole('group', { name: 'Which recording is this?' })
  await expect(chooser).toBeVisible()
  await expect(page.getByText('No lyrics found')).toBeVisible() // the fallback providers had nothing either
  await expect(chooser.getByRole('button')).toHaveCount(3) // two recordings + "None of these"

  await chooser.getByRole('button', { name: /Greatest Hits/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Lyrics' }).getByRole('button', { name: 'I count the lights' })).toBeVisible()
  await expect(page.locator('summary')).toBeFocused() // focus is not dropped when the chooser goes away
  await expect(page.locator('summary')).toContainText('· linked')
})

test('a track with no Spotify match keeps its server lyrics', async ({ page }) => {
  await play(page, 'Line Dancer')
  await expect(page.getByRole('region', { name: 'Lyrics' }).getByRole('button', { name: 'Line one' })).toBeVisible()
  await expect(page.getByText('Lyrics from your server')).toBeVisible()
  await expect(page.locator('summary')).toContainText('· no Spotify match')
})

test('production CSS keeps the sweep, the edge fade and the glass resume control; manual scroll and resume work', async ({ page }) => {
  await play(page, 'Quiet Hours')
  const lyrics = page.getByRole('region', { name: 'Lyrics' })
  await expect(lyrics.getByRole('button', { name: 'I count the lights' })).toBeVisible()
  const css = await page.evaluate(() => {
    const syl = getComputedStyle(document.querySelector('.syl')!)
    return { clip: syl.backgroundClip || syl.getPropertyValue('-webkit-background-clip'), image: syl.backgroundImage, mask: getComputedStyle(document.querySelector('.lyrics')!).maskImage }
  })
  expect(css.clip).toBe('text')
  expect(css.image).toContain('linear-gradient')
  expect(css.mask).toContain('linear-gradient')

  await lyrics.hover()
  await page.mouse.wheel(0, 500)
  const resume = page.getByRole('button', { name: 'Back to current line' })
  await expect(resume).toBeVisible()
  await expect(page.getByRole('button', { name: 'Follow playback' })).toHaveAttribute('aria-pressed', 'false')
  expect(await resume.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur')
  await resume.click()
  await expect(resume).toBeHidden()
  // Back in the focal region: the active line sits about a third of the way down the lyrics viewport.
  await expect
    .poll(() => page.evaluate(() => {
      const box = document.querySelector('.lyrics')!
      const top = box.querySelector('[aria-current]')!.getBoundingClientRect().top - box.getBoundingClientRect().top
      return Math.round((top / box.clientHeight) * 100)
    }))
    .toBe(32)
})

test('word painting touches only the active line, and never re-renders the lyrics while a line is sung', async ({ page }) => {
  await play(page, 'Quiet Hours')
  await expect(page.locator('.syl.is-active')).toHaveCount(1, { timeout: 10_000 })
  const r = await page.evaluate(async () => {
    const out = { childList: 0, outside: 0, styleWrites: 0 }
    const mo = new MutationObserver((records) => {
      for (const m of records) {
        if (m.type === 'childList') out.childList++
        const el = m.target instanceof Element ? m.target : m.target.parentElement
        if (m.attributeName === 'style') {
          if (el?.closest('.lyric--active')) out.styleWrites++
          else out.outside++
        }
      }
    })
    mo.observe(document.querySelector('.lyrics')!, { subtree: true, childList: true, attributes: true })
    await new Promise((r) => setTimeout(r, 2000))
    mo.disconnect()
    return out
  })
  expect(r.outside).toBe(0)
  expect(r.childList).toBe(0)
  expect(r.styleWrites).toBeGreaterThan(20) // smooth: many frames of progress per second…
  expect(r.styleWrites).toBeLessThan(400) // …but about one write per frame, not one per syllable per frame
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })
  test('lines jump into place without travel and syllables do not rise', async ({ page }) => {
    await play(page, 'Quiet Hours')
    await expect(page.locator('.syl.is-active')).toHaveCount(1, { timeout: 10_000 })
    expect(await page.locator('.lyric--active .syl').first().evaluate((el) => getComputedStyle(el).transform)).toBe('none')
    // When the line changes, the scroll position is final in the very next frame.
    const steady = await page.evaluate(() => new Promise<boolean>((resolve) => {
      const box = document.querySelector('.lyrics')!
      const first = box.querySelector('[aria-current]')
      const watch = () => {
        if (box.querySelector('[aria-current]') === first) return requestAnimationFrame(watch)
        const y = box.scrollTop
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(box.scrollTop === y)))
      }
      watch()
    }))
    expect(steady).toBe(true)
  })
})

test('phone width: no horizontal overflow, compact header, lyrics in view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 })
  await play(page, 'Quiet Hours')
  const lyrics = page.getByRole('region', { name: 'Lyrics' })
  await expect(lyrics.getByRole('button', { name: /And every quiet hour/ })).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.evaluate(() => { const b = document.querySelector('.lyrics')!; return b.scrollWidth <= b.clientWidth })).toBe(true)
  await expect(lyrics).toBeInViewport()
})
