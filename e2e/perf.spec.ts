import { expect, test, type Page } from '@playwright/test'

// Measurements use headless Chromium with software rendering, so absolute frame rates are NOT
// representative of a real device. Structural assertions (DOM size, what re-renders) are deterministic;
// timings are only logged.
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
  await page.getByLabel('Remember this device').check() // full page loads below would otherwise drop the in-memory session
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
}

test('10,000-artist list: DOM stays windowed and scrolling is smooth enough to measure', async ({ page, request }) => {
  await request.get(`${MOCK}/__bulk?artists=10000`)
  await connect(page)
  const list = page.getByRole('list', { name: 'Artists' })
  await expect(list.getByRole('listitem').first()).toBeVisible()

  const rowsAtTop = await list.getByRole('listitem').count()
  expect(rowsAtTop).toBeLessThan(40)

  const result = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[aria-label="Artists"].vlist')!
    const longTasks: number[] = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration))).observe({ entryTypes: ['longtask'] as string[] as never })
    const deltas: number[] = []
    let last = performance.now()
    const total = el.scrollHeight - el.clientHeight
    const start = last
    await new Promise<void>((done) => {
      const frame = (now: number) => {
        deltas.push(now - last)
        last = now
        const t = Math.min(1, (now - start) / 3000)
        el.scrollTop = t * total // a full top-to-bottom pass over 10k rows in 3 s
        if (t < 1) requestAnimationFrame(frame)
        else done()
      }
      requestAnimationFrame(frame)
    })
    const sorted = [...deltas].sort((a, b) => a - b)
    return {
      frames: deltas.length,
      avgFps: Math.round((deltas.length / (deltas.reduce((a, b) => a + b, 0) / 1000)) * 10) / 10,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 10) / 10,
      worstFrameMs: Math.round(sorted[sorted.length - 1]! * 10) / 10,
      longTasks: longTasks.length,
      domRows: el.querySelectorAll('[role="listitem"]').length,
      totalRows: Number(el.querySelector('[role="listitem"]')?.getAttribute('aria-setsize')),
    }
  })
  console.log('PERF 10k-row scroll (headless, software rendering):', JSON.stringify(result))
  expect(result.totalRows).toBe(10_000)
  expect(result.domRows).toBeLessThan(40) // windowed the whole way down
})

test('playhead ticks only touch the progress controls, on the library and on Now Playing', async ({ page }) => {
  await connect(page)
  await page.goto('/library/albums/al1')
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Player' }).getByRole('button', { name: 'Pause' })).toBeVisible()

  // Count DOM mutations by where they happen while audio plays for ~3 s.
  const observe = (path: string) =>
    page.evaluate(async (route) => {
      history.pushState({}, '', route)
      dispatchEvent(new PopStateEvent('popstate'))
      await new Promise((r) => setTimeout(r, 400))
      const buckets: Record<string, number> = {}
      const mo = new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target instanceof Element ? r.target : r.target.parentElement
          const key = el?.closest('.progress') ? 'progress' : el?.closest('.lyrics') ? 'lyrics' : el?.closest('.player') ? 'player-other' : 'page-other'
          buckets[key] = (buckets[key] ?? 0) + 1
        }
      })
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
      await new Promise((r) => setTimeout(r, 3000))
      mo.disconnect()
      return buckets
    }, path)

  const library = await observe('/library/albums/al1')
  console.log('PERF mutations while playing (album page):', JSON.stringify(library))
  expect(library['progress']).toBeGreaterThan(0)
  expect(library['player-other'] ?? 0).toBe(0)
  expect(library['page-other'] ?? 0).toBe(0)

  const now = await observe('/now-playing')
  console.log('PERF mutations while playing (Now Playing):', JSON.stringify(now))
  expect(now['player-other'] ?? 0).toBe(0)
  expect(now['page-other'] ?? 0).toBe(0)
  // Lyrics change only when the active line changes: a handful of attribute/class flips, not one per tick.
  expect(now['lyrics'] ?? 0).toBeLessThan(40)
})

test('rapid track skipping settles on the last track without errors', async ({ page }) => {
  await connect(page)
  await page.goto('/library/albums/al1')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: 'Play Line Dancer', exact: true }).click()
  const bar = page.getByRole('region', { name: 'Player' })
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  for (let i = 0; i < 30; i++) await page.keyboard.press('n') // far faster than streams can start
  // 3-track album with repeat off: skipping stops at the last track.
  await expect(bar.getByText('Third Song')).toBeVisible()
  await expect(bar.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
})
