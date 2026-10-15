import { createRequire } from 'node:module'
import { expect, test, type Page } from '@playwright/test'

// Social in a real browser against the mock server: "alex" is playing Stayin Alive now, "sam" reported a track long ago,
// and the chat room starts with one message from alex (`/__chat` adds messages or turns chat off like Navidrome).

const MOCK = 'http://127.0.0.1:4599'
const axePath = createRequire(import.meta.url).resolve('axe-core')

declare global {
  interface Window {
    __audios: HTMLMediaElement[]
  }
}

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
  await page.addInitScript(() => {
    window.__audios = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!window.__audios.includes(this)) window.__audios.push(this)
      return play.call(this)
    }
  })
})

async function connect(page: Page, mobile = false) {
  await page.goto(mobile ? '/?mobile=1' : '/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  if (mobile) await expect(page.getByRole('link', { name: 'Social', exact: true })).toBeVisible()
  else await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
}

const playing = (page: Page) =>
  page.evaluate(() => {
    const el = window.__audios.at(-1)
    return el ? { src: el.currentSrc, time: el.currentTime, paused: el.paused } : null
  })

async function seriousViolations(page: Page) {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; impact: string; nodes: { html: string }[] }[] }> } }).axe
    const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 80)).join(' | ')}`)
  })
}

test('desktop: Social sits top-left, opens real activity and chat, and music keeps playing throughout', async ({ page, request }) => {
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

  const tabs = page.getByRole('navigation', { name: 'Social' })
  await tabs.getByRole('link', { name: /Chat/ }).click()
  const log = page.getByRole('log', { name: 'Messages' })
  await expect(log).toContainText('Anyone else on a Bee Gees kick?')
  await page.getByRole('textbox', { name: 'Message everyone on this server' }).fill('Hello from the e2e run')
  await page.keyboard.press('Enter')
  await expect(log).toContainText('Hello from the e2e run')
  expect(await seriousViolations(page)).toEqual([])

  // A new message while elsewhere: the badge appears when the app next checks (here: on returning to the window).
  await tabs.getByRole('link', { name: 'People' }).click()
  await request.get(`${MOCK}/__chat?say=${encodeURIComponent('Welcome!')}&as=sam`)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(nav.getByRole('link', { name: 'Social, 1 unread' })).toBeVisible()
  await page.getByRole('link', { name: /^sam/ }).click()
  await expect(page.getByRole('heading', { name: 'sam', level: 2 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Recent messages' })).toContainText('Welcome!')
  await page.getByRole('button', { name: 'Mention in server chat' }).click()
  await expect(page.getByRole('textbox', { name: 'Message everyone on this server' })).toHaveValue('@sam ')
  await expect(nav.getByRole('link', { name: 'Social', exact: true })).toBeVisible() // read

  const after = (await playing(page))!
  expect(after.src).toBe(before.src)
  expect(after.paused).toBe(false)
  expect(after.time).toBeGreaterThan(before.time)
})

test('a server without chat (Navidrome answers 410) gets an honest unavailable state', async ({ page, request }) => {
  await request.get(`${MOCK}/__chat?gone=1`)
  await connect(page)
  await page.goto('/social/chat')
  await expect(page.getByText('Chat isn’t available on this server')).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
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

test('narrow web: Social is the first tab at the top-left, without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 })
  await connect(page)
  const social = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Social' })
  await expect(social).toBeVisible()
  const box = (await social.boundingBox())!
  expect(box.x).toBeLessThan(20)
  expect(box.y).toBeLessThan(20)
  for (const path of ['/social', '/social/chat/server', '/social/people', '/social/people/alex']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Social', level: 1 })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  }
})

for (const [label, viewport] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]] as const) {
  test(`phone UI (${label}): Social button top-left on every tab; Social fits the screen; playback continues`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await connect(page, true)
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
