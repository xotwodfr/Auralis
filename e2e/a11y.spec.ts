import { createRequire } from 'node:module'
import { expect, test, type Page } from '@playwright/test'

// axe-core in a real browser, so the colour-contrast rule (which jsdom cannot evaluate) actually runs.
const axePath = createRequire(import.meta.url).resolve('axe-core')
const MOCK = 'http://127.0.0.1:4599'
const THEMES = ['light', 'dark', 'midnight', 'oled', 'nord', 'sunset', 'sakura', 'forest', 'artwork']
const PAGES = [
  ['artists', '/library/artists'],
  ['album', '/library/albums/al1'],
  ['now playing (lyrics)', '/now-playing'],
  ['settings', '/settings'],
] as const

async function scan(page: Page) {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; impact: string; nodes: { html: string; any: { message: string }[] }[] }[] }> } }).axe
    const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })
    return r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => `${n.html.slice(0, 90)} [${n.any[0]?.message?.slice(0, 80)}]`).join(' | ')}`)
  })
}

test.beforeEach(async ({ page, request }) => {
  await request.get(`${MOCK}/__reset`)
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
})

for (const theme of THEMES) {
  test(`no serious/critical axe violations (incl. contrast) in the ${theme} theme`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('auralis-theme', t), theme)
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
    if (theme === 'artwork') await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toMatch(/^#/)

    const found: Record<string, string[]> = {}
    for (const [name, path] of PAGES) {
      await page.getByRole('link', { name: path === '/now-playing' ? 'Now Playing' : path === '/settings' ? 'Settings' : path === '/library/artists' ? 'Artists' : 'Albums', exact: true }).first().click()
      if (path === '/library/albums/al1') await page.getByRole('link', { name: /First Album/ }).click()
      if (path === '/now-playing') await expect(page.getByRole('button', { name: 'Line one' })).toBeVisible()
      await page.waitForTimeout(350) // let colour transitions settle
      const v = await scan(page)
      if (v.length) found[name] = v
    }
    // Word-synced lyrics too (an automatic Spotify match), with a syllable being sung.
    await page.goto('/library/albums/al1')
    await page.getByRole('button', { name: 'Play Quiet Hours', exact: true }).click()
    await page.getByRole('link', { name: 'Now Playing', exact: true }).click()
    await expect(page.locator('.syl.is-active')).toHaveCount(1, { timeout: 10_000 })
    const v = await scan(page)
    if (v.length) found['now playing (word-synced)'] = v
    expect(found).toEqual({})
  })
}
