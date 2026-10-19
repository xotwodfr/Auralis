import { expect, test, type Page } from '@playwright/test'

// Real audio, real browser: the mock server streams a 440 Hz sine for "Fifth Song", and an init script taps whatever the
// app connects to the speakers into an analyser, so these checks measure the sound that comes out, not UI state.

const MOCK = 'http://127.0.0.1:4599'

declare global {
  interface Window {
    __tap?: AnalyserNode
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
    const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      if (args[0] instanceof AudioDestinationNode) {
        window.__tap ??= Object.assign(this.context.createAnalyser(), { fftSize: 16384, smoothingTimeConstant: 0 })
        connect.call(this, window.__tap)
      }
      return connect.apply(this, args)
    } as typeof AudioNode.prototype.connect
  })
})

/** The loudest frequency at the graph's output, in Hz (bin width ~3 Hz). */
const peakHz = (page: Page) =>
  page.evaluate(() => {
    const a = window.__tap
    if (!a) return 0
    const bins = new Float32Array(a.frequencyBinCount)
    a.getFloatFrequencyData(bins)
    let best = 1
    for (let i = 1; i < bins.length; i++) if (bins[i]! > bins[best]!) best = i
    return (best * a.context.sampleRate) / a.fftSize
  })

/** RMS level of the last ~85 ms at the graph's output, in dBFS. */
const level = (page: Page) =>
  page.evaluate(() => {
    const a = window.__tap
    if (!a) return -Infinity
    const buf = new Float32Array(a.fftSize)
    a.getFloatTimeDomainData(buf)
    const recent = buf.subarray(-4096)
    return 20 * Math.log10(Math.sqrt(recent.reduce((s, v) => s + v * v, 0) / recent.length) || 1e-12)
  })

const media = (page: Page) => page.evaluate(() => {
  const el = window.__audios.at(-1)
  return el ? { rate: el.playbackRate, keepsPitch: el.preservesPitch, time: el.currentTime, src: el.currentSrc, paused: el.paused } : null
})

/** How far the output's loudest frequency is from `hz`. */
const offBy = (page: Page, hz: number) => async () => Math.abs((await peakHz(page)) - hz)

test('effects change the real output: speed keeps pitch, pitch keeps speed, bypass, EQ and reverb', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()))

  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByLabel('Remember this device').check()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()
  await page.goto('/library/albums/al2')
  await page.getByRole('button', { name: 'Play Fifth Song', exact: true }).click()
  const bar = page.getByRole('region', { name: 'Player' })
  await expect(bar.getByRole('button', { name: 'Pause' })).toBeVisible()
  await bar.getByRole('link', { name: /^Now playing:/ }).click()
  await page.getByRole('button', { name: 'Audio effects' }).click()
  const fx = page.getByRole('complementary', { name: 'Audio Effects' })
  await expect(fx).toBeVisible()

  await test.step('speed: the element plays 1.5× faster with pitch preserved', async () => {
    await fx.getByRole('slider', { name: 'Playback speed' }).fill('1.5')
    expect(await media(page)).toMatchObject({ rate: 1.5, keepsPitch: true })
    const t0 = (await media(page))!.time
    const w0 = Date.now()
    await page.waitForTimeout(2000)
    const advanced = (await media(page))!.time - t0
    expect(advanced / ((Date.now() - w0) / 1000)).toBeGreaterThan(1.3)
  })

  const src = (await media(page))!.src
  await test.step('pitch +12: the output moves an octave up (440 → 880 Hz) while speed stays 1.5×', async () => {
    await fx.getByRole('slider', { name: 'Pitch' }).fill('12')
    await expect.poll(offBy(page, 880), { timeout: 10_000 }).toBeLessThan(22)
    expect((await media(page))!.rate).toBe(1.5)
  })

  await test.step('bypass: back to the original 440 Hz at 1×, without reloading; re-enable restores both', async () => {
    const loadedSrc = (await media(page))!.src // the one CORS reload for the graph happened above
    await fx.getByRole('checkbox', { name: 'Effects' }).uncheck()
    await expect.poll(offBy(page, 440)).toBeLessThan(11)
    expect((await media(page))!.rate).toBe(1)
    await expect(fx.getByRole('slider', { name: 'Pitch' })).toHaveValue('12')
    await fx.getByRole('checkbox', { name: 'Effects' }).check()
    await expect.poll(offBy(page, 880)).toBeLessThan(22)
    expect(await media(page)).toMatchObject({ rate: 1.5, src: loadedSrc, paused: false })
  })
  expect(src).toContain('id=s5')

  await test.step('pitch reset: 440 Hz again', async () => {
    await fx.getByRole('button', { name: 'Reset pitch' }).click()
    await expect.poll(offBy(page, 440)).toBeLessThan(11)
  })

  await test.step('equalizer: cutting the bands around 440 Hz lowers the level; flat restores it', async () => {
    await fx.getByRole('checkbox', { name: 'Equalizer' }).check()
    await page.waitForTimeout(500)
    const before = await level(page)
    await fx.getByRole('slider', { name: '250 Hz' }).fill('-12')
    await fx.getByRole('slider', { name: '500 Hz' }).fill('-12')
    await expect.poll(() => level(page)).toBeLessThan(before - 6)
    await fx.getByRole('button', { name: 'Reset to flat' }).click()
    await expect.poll(() => level(page)).toBeGreaterThan(before - 1)
  })

  await test.step('reverb: a hall tail keeps sounding after pause; without reverb it stops at once', async () => {
    const tailAfterPause = async () => {
      await bar.getByRole('button', { name: 'Pause' }).click()
      await page.waitForTimeout(300)
      const l = await level(page)
      await bar.getByRole('button', { name: 'Play' }).click()
      await page.waitForTimeout(800)
      return l
    }
    const dry = await tailAfterPause()
    await fx.getByRole('checkbox', { name: 'Reverb' }).check()
    await fx.getByRole('radio', { name: 'Hall' }).click()
    await fx.getByRole('slider', { name: 'Reverb amount' }).fill('1')
    await page.waitForTimeout(800)
    const wet = await tailAfterPause()
    expect(dry).toBeLessThan(-70)
    expect(wet).toBeGreaterThan(-40)
  })

  expect(errors).toEqual([])
})
