import { expect, test, type Page } from '@playwright/test'

const MOCK = 'http://127.0.0.1:4599'

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
})

async function connect(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
}

test('favourites survive a reload and reach the Favorites page', async ({ page }) => {
  await connect(page)
  await page.goto('/library/albums/al1')
  const tracks = page.getByRole('list', { name: 'Tracks' })
  await tracks.getByRole('button', { name: 'Add Quiet Hours to favorites' }).click()
  await expect(tracks.getByRole('button', { name: 'Remove Quiet Hours from favorites' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('list', { name: 'Tracks' }).getByRole('button', { name: 'Remove Quiet Hours from favorites' })).toBeVisible()

  await page.getByRole('link', { name: 'Favorites', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Favorite tracks' }).getByText('Quiet Hours')).toBeVisible()
})

test('track actions: add to a playlist, then remove it there', async ({ page }) => {
  await connect(page)
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'More actions for Third Song' }).click()
  const menu = page.getByRole('dialog')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Add to playlist…' }).click()
  await menu.getByRole('button', { name: 'Road trip' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Road trip')

  await page.getByRole('link', { name: 'Playlists', exact: true }).click()
  await page.getByRole('link', { name: /Road trip/ }).click()
  const tracks = page.getByRole('list', { name: 'Tracks' })
  await expect(tracks.getByText('Third Song')).toBeVisible()

  await tracks.getByRole('button', { name: 'More actions for Third Song' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from this playlist' }).click()
  await expect(tracks.getByText('Third Song')).toHaveCount(0)
})

test('the track menu is keyboard operable and returns focus', async ({ page }) => {
  await connect(page)
  await page.goto('/library/albums/al1')
  const more = page.getByRole('button', { name: 'More actions for Line Dancer' })
  await more.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('dialog')
  await expect(menu.getByRole('button', { name: 'Play next' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('"now playing" stays private until shared; the play-count preference stops reports', async ({ page, request }) => {
  const scrobbles = async () => (await (await request.get(`${MOCK}/__stats`)).json()).scrobble ?? 0
  const bar = page.getByRole('region', { name: 'Player' })
  await connect(page)
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.waitForTimeout(1500)
  expect(await scrobbles()).toBe(0) // no "now playing" ping by default; the play itself is recorded at half the track
  await bar.getByRole('button', { name: 'Pause' }).click()

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Playback' }).click()
  await page.getByLabel('Share what I’m playing').check()
  await page.getByRole('link', { name: 'Albums', exact: true }).click()
  await page.getByRole('link', { name: /First Album/ }).click()
  await page.getByRole('button', { name: 'Play Quiet Hours', exact: true }).click()
  await expect.poll(scrobbles, { timeout: 10_000 }).toBeGreaterThan(0)

  // Stop first: the running track would otherwise submit its own play while the baseline is read.
  await bar.getByRole('button', { name: 'Pause' }).click()
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Playback' }).click()
  const toggle = page.getByLabel('Report plays to your server')
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await page.getByLabel('Share what I’m playing').uncheck()
  await page.waitForTimeout(500)
  const before = await scrobbles()
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Third Song', exact: true }).click()
  await page.waitForTimeout(1500)
  expect(await scrobbles()).toBe(before)
})

test('the collapsed sidebar persists and keeps every destination reachable', async ({ page }) => {
  await connect(page)
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click()
  await expect(page.getByRole('link', { name: 'Albums', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Expand the sidebar' })).toBeVisible()
  await page.getByRole('link', { name: 'Albums', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Albums', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Expand the sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Collapse the sidebar' })).toBeVisible()
})

test('a new route starts at the top of the page', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 })
  await connect(page)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 400))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
  await page.getByRole('link', { name: 'Albums', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Albums', level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
})
