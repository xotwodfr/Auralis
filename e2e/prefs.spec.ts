import { expect, test, type Page } from '@playwright/test'

const MOCK = 'http://127.0.0.1:4599'

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
}

test.beforeEach(async ({ request }) => {
  await request.get(`${MOCK}/__reset`)
})

test('System theme follows the OS colour scheme, live', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await signIn(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('reduced motion removes transitions and the theme ease', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await signIn(page)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const duration = await page.getByRole('button', { name: 'Disconnect' }).evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(parseFloat(duration)).toBeLessThan(0.001)
  await page.getByRole('radio', { name: 'Nord' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord')
  expect(await page.locator('html').evaluate((el) => el.classList.contains('theme-changing'))).toBe(false)
})

test('increased contrast turns glass surfaces opaque', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more' })
  await signIn(page)
  const bg = await page.locator('.toolbar').evaluate((el) => ({ color: getComputedStyle(el).backgroundColor, blur: getComputedStyle(el).backdropFilter }))
  expect(bg.color).not.toMatch(/rgba|, 0\.\d+\)/) // no alpha channel: fully opaque
  expect(bg.blur).toBe('none')
})

test('translucent glass is used by default', async ({ page }) => {
  await signIn(page)
  const bg = await page.locator('.toolbar').evaluate((el) => ({ color: getComputedStyle(el).backgroundColor, blur: getComputedStyle(el).backdropFilter }))
  expect(bg.color).toMatch(/rgba|\/ 0\./)
  expect(bg.blur).toContain('blur')
})

test('long titles and narrow widths do not overflow the player', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 })
  await signIn(page)
  await page.goto('/library/albums/al3')
  await page.getByRole('button', { name: /^Play A very long song title/ }).first().click()
  const bar = page.getByRole('region', { name: 'Player' })
  await expect(bar).toBeVisible()
  const box = await bar.boundingBox()
  expect(box!.width).toBeLessThanOrEqual(360)
  const title = bar.locator('.player__title')
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true) // truncated, not wrapped or overflowing
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.goto('/library/albums/al3')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true) // long row titles ellipsize
})
