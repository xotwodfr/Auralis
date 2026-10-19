import { expect, test, type Page } from '@playwright/test'
import { playing, seriousViolations, trackAudio } from '../../shared/ui/testing/e2e-helpers'

// The phone UI in a real browser against the mock server (the same fixtures the web suite uses): "alex" is playing
// Stayin Alive now and the chat room starts with one message from alex.

const MOCK = 'http://127.0.0.1:4699'

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
  await trackAudio(page)
})

async function connect(page: Page) {
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: 'Social', exact: true })).toBeVisible()
}

for (const [label, viewport] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]] as const) {
  test(`phone UI (${label}): Social button top-left on every tab; Social fits the screen; playback continues`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await connect(page)
    await page.goto('/library/albums/al1')
    await page.getByRole('button', { name: 'Play First Album' }).click()
    await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible()
    await expect.poll(async () => (await playing(page))?.time ?? 0).toBeGreaterThan(0)
    const before = (await playing(page))!

    for (const tab of ['Home', 'Search', 'Your Library']) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: tab }).click()
      const button = page.getByRole('link', { name: 'Social', exact: true })
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(tab === 'Home' ? /^Good / : tab)
      const box = (await button.boundingBox())!
      expect(box.x).toBeLessThan(40)
      expect(box.y).toBeLessThan(80)
      expect(box.width).toBeGreaterThanOrEqual(36)
    }
    await page.getByRole('link', { name: 'Social', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Listening activity' }).getByRole('listitem')).toHaveCount(2)
    await expect(page.getByRole('switch', { name: 'Share what I’m playing' })).toHaveAttribute('aria-checked', 'false')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
    expect(await seriousViolations(page)).toEqual([])

    await page.getByRole('navigation', { name: 'Social' }).getByRole('link', { name: /Chat/ }).click()
    await page.getByRole('link', { name: /Everyone on/ }).click()
    const field = page.getByRole('textbox', { name: 'Message everyone on this server' })
    await expect(field).toBeVisible()
    // The composer stays above the mini-player and tab bar.
    const composer = (await field.boundingBox())!
    const dock = (await page.locator('.m-dock').boundingBox())!
    expect(composer.y + composer.height).toBeLessThanOrEqual(dock.y + 1)
    await field.fill('From the phone')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByRole('log', { name: 'Messages' })).toContainText('From the phone')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('link', { name: /Everyone on/ })).toBeVisible()
    const after = (await playing(page))!
    expect(after.src).toBe(before.src)
    expect(after.paused).toBe(false)
    expect(after.time).toBeGreaterThan(before.time)
  })
}
