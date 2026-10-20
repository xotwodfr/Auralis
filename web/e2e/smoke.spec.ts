import { expect, test, type Page } from '@playwright/test'

const MOCK = 'http://127.0.0.1:4599'
const USER = 'demo'
const PASSWORD = 'e2e-pass'

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  // Lyrics fall back to LRCLIB when the server has none; keep the run offline and deterministic.
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
})

async function connect(page: Page, remember = true) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Auralis' })).toBeVisible()
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill(USER)
  await page.getByLabel('Password').fill(PASSWORD)
  if (remember) await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
}

const player = (page: Page) => page.getByRole('region', { name: 'Player' })
const seekValue = async (page: Page) => Number(await player(page).getByRole('slider', { name: 'Seek' }).inputValue())

test('critical journey: connect → browse → search → play → queue → lyrics → themes → reload → failure', async ({ page, request }) => {
  // The injected 503 makes the browser log "Failed to load resource"; anything else is a real problem.
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && problems.push(`console: ${m.text()}`))

  await test.step('connect', async () => {
    await connect(page)
  })

  await test.step('browse artist → album', async () => {
    await page.getByRole('link', { name: /Artist A/ }).click()
    await expect(page.getByRole('heading', { name: 'Artist A', level: 1 })).toBeVisible()
    await page.getByRole('link', { name: /First Album/ }).click()
    await expect(page.getByRole('heading', { name: 'First Album', level: 1 })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Tracks' }).getByText('Quiet Hours')).toBeVisible()
  })

  await test.step('search', async () => {
    await page.getByRole('searchbox', { name: 'Search library' }).fill('bee')
    await expect(page.getByRole('heading', { name: /Results for/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /Bee Gees/ }).first()).toBeVisible()
    await page.getByRole('link', { name: 'Albums', exact: true }).click()
  })

  await test.step('play a track and watch the player state', async () => {
    await page.goto('/library/albums/al1')
    await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
    await expect(player(page).getByText('Line Dancer')).toBeVisible()
    await expect(player(page).getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect.poll(() => seekValue(page), { timeout: 10_000 }).toBeGreaterThan(1)
  })

  await test.step('queue: add, reorder, remove', async () => {
    // Playing a track queues its whole album; add a track from another album.
    await page.goto('/library/albums/al2')
    // A full reload drops playback (it restores paused), so start again from al1 first.
    await page.goto('/library/albums/al1')
    await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
    await expect(player(page).getByRole('button', { name: 'Pause' })).toBeVisible()
    await page.getByRole('link', { name: 'Albums', exact: true }).click()
    await page.getByRole('link', { name: /Second Album/ }).click()
    await page.getByRole('button', { name: 'More actions for Fourth Song' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Add to queue' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await player(page).getByRole('button', { name: 'Queue' }).click()
    const queue = page.getByRole('complementary', { name: 'Queue' })
    const titles = () => queue.getByRole('list', { name: 'Queue' }).locator('.row__title').allTextContents()
    await expect.poll(titles).toEqual(['Line Dancer', 'Quiet Hours', 'Third Song', 'Fourth Song'])
    await queue.getByRole('button', { name: 'Move Fourth Song up' }).click()
    await expect.poll(titles).toEqual(['Line Dancer', 'Quiet Hours', 'Fourth Song', 'Third Song'])
    await queue.getByRole('button', { name: 'Remove Quiet Hours from queue' }).click()
    await expect.poll(titles).toEqual(['Line Dancer', 'Fourth Song', 'Third Song'])
    await page.keyboard.press('Escape')
    await expect(queue).toBeHidden()
  })

  await test.step('Now Playing shows synced lyrics that follow the playhead and seek on click', async () => {
    await page.getByRole('link', { name: 'Now Playing', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Line Dancer', level: 1 })).toBeVisible()
    const lyrics = page.getByRole('region', { name: 'Lyrics' })
    await expect(lyrics.getByRole('button', { name: 'Line one' })).toBeVisible()
    await expect(lyrics.getByRole('button', { name: /Line (one|two)/ }).and(page.locator('[aria-current]'))).toBeVisible({ timeout: 10_000 })
    await lyrics.getByRole('button', { name: 'Line three' }).click()
    await expect(lyrics.getByRole('button', { name: 'Line three' })).toHaveAttribute('aria-current', 'true')
    expect(await seekValue(page)).toBeGreaterThanOrEqual(10)
  })

  await test.step('navigating keeps playback running', async () => {
    const before = await seekValue(page)
    await page.getByRole('link', { name: 'Artists', exact: true }).click()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(player(page).getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect.poll(() => seekValue(page), { timeout: 10_000 }).toBeGreaterThan(before)
  })

  await test.step('themes: preset and Album Artwork', async () => {
    const html = page.locator('html')
    await page.getByRole('radio', { name: 'Nord' }).click()
    await expect(html).toHaveAttribute('data-theme', 'nord')
    await page.getByRole('radio', { name: 'Album Artwork' }).click()
    await expect(html).toHaveAttribute('data-theme', 'artwork')
    // Cover art is a solid red PNG served with CORS headers, so the palette is a red hue.
    await expect.poll(() => html.evaluate((el) => el.style.getPropertyValue('--accent'))).toMatch(/^#/)
    const accent = await html.evaluate((el) => el.style.getPropertyValue('--accent'))
    const r = parseInt(accent.slice(1, 3), 16)
    const b = parseInt(accent.slice(5, 7), 16)
    expect(r).toBeGreaterThan(b)
    await page.getByRole('link', { name: 'Albums', exact: true }).click()
    expect(await html.evaluate((el) => el.style.getPropertyValue('--accent'))).toBe(accent)
  })

  await test.step('reload restores the session, theme and queue (paused)', async () => {
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Albums', level: 1 })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'artwork')
    // Let the page's own album request finish, so the injected failure below hits the next one.
    await expect(page.getByRole('link', { name: /First Album/ }).first()).toBeVisible()
    await expect(player(page).getByText('Line Dancer')).toBeVisible()
    await expect(player(page).getByRole('button', { name: 'Play' })).toBeVisible() // browsers can't resume audio by themselves
  })

  await test.step('an API failure shows an error and recovers on retry', async () => {
    await request.get(`${MOCK}/__fail?endpoint=getAlbumList2&times=1`)
    await page.getByRole('link', { name: 'Recent', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('link', { name: /First Album/ }).first()).toBeVisible()
  })

  expect(problems).toEqual([])
})

test('wrong password shows a clear error and stores nothing', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill(USER)
  await page.getByLabel('Password').fill('nope')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong username or password.')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible()
})

test('keyboard: shortcuts and tab order', async ({ page }) => {
  await connect(page)
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  await expect(player(page).getByRole('button', { name: 'Pause' })).toBeVisible()

  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Space')
  await expect(player(page).getByRole('button', { name: 'Play' })).toBeVisible()
  await page.keyboard.press('Space')
  await expect(player(page).getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.keyboard.press('n')
  await expect(player(page).getByText('Quiet Hours')).toBeVisible()

  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toBeFocused()
  await page.keyboard.type('p n') // typing never triggers shortcuts
  await expect(player(page).getByText('Quiet Hours')).toBeVisible()

  await page.keyboard.press('Escape')
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => {
    const el = document.activeElement
    return el ? getComputedStyle(el).outlineStyle !== 'none' : false
  })
  expect(focused).toBe(true) // a focus ring is drawn on keyboard focus
})

test('narrow viewport: no horizontal overflow, player and navigation usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await connect(page)
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  await expect(player(page)).toBeVisible()
  for (const path of ['/library/albums/al1', '/now-playing', '/settings']) {
    await page.goto(path)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, path).toBeLessThanOrEqual(0)
  }
})
