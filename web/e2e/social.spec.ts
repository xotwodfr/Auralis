import { expect, test, type Page } from '@playwright/test'
import { playing, seriousViolations, trackAudio } from '../../shared/ui/testing/e2e-helpers'

// Social in a real browser against the mock server: "alex" is playing Stayin Alive now, "sam" reported a track long ago.

const MOCK = 'http://127.0.0.1:4599'

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
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
}

test('desktop: Social sits top-left, opens real activity and people, and music keeps playing throughout', async ({ page }) => {
  await connect(page)

  // Top-left: the first destination, above every other one, in the left column.
  const nav = page.getByRole('navigation', { name: 'Main' })
  const social = nav.getByRole('link', { name: 'Social' })
  const box = (await social.boundingBox())!
  const nowPlaying = (await nav.getByRole('link', { name: 'Now Playing' }).boundingBox())!
  expect(box.x).toBeLessThan(40)
  expect(box.y).toBeLessThan(nowPlaying.y)
  expect(box.y).toBeLessThan(120)

  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect.poll(async () => (await playing(page))?.time ?? 0).toBeGreaterThan(0)
  const before = (await playing(page))!

  await social.click()
  const activity = page.getByRole('list', { name: 'Listening activity' })
  await expect(activity.getByRole('listitem')).toHaveCount(2)
  await expect(activity.getByRole('listitem').first()).toContainText('Listening now · Feishin')
  await expect(activity.getByRole('listitem').nth(1)).toContainText(/Played 2 h ago/)
  expect(await seriousViolations(page)).toEqual([])

  await page.getByRole('navigation', { name: 'Social' }).getByRole('link', { name: 'People' }).click()
  await page.getByRole('list', { name: 'People' }).getByRole('link', { name: /^sam/ }).click()
  await expect(page.getByRole('heading', { name: 'sam', level: 2 })).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])

  const after = (await playing(page))!
  expect(after.src).toBe(before.src)
  expect(after.paused).toBe(false)
  expect(after.time).toBeGreaterThan(before.time)
})

test('sharing: off by default; turning it on makes the user show up for others', async ({ page, request }) => {
  await connect(page)
  await page.goto('/social')
  const toggle = page.getByRole('checkbox', { name: 'Share what I’m playing' })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Albums' }).click()
  await page.getByRole('link', { name: /First Album/ }).click()
  await page.getByRole('button', { name: 'Play Quiet Hours', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`${MOCK}/__stats`)).json()).scrobble ?? 0, { timeout: 10_000 }).toBeGreaterThan(0)
})

test('narrow web: Social is the first tab of the bottom navigation bar, without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 })
  await connect(page)
  const social = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Social' })
  await expect(social).toBeVisible()
  const box = (await social.boundingBox())!
  expect(box.x).toBeLessThan(20)
  expect(box.y).toBeGreaterThan(740 - 100) // M3 navigation bar sits at the bottom
  for (const path of ['/social', '/social/people', '/social/people/alex']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Social', level: 1 })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  }
})
