import { createRequire } from 'node:module'
import type { Page } from '@playwright/test'

// Browser-side helpers shared by the web and android Playwright suites.

const axePath = createRequire(import.meta.url).resolve('axe-core')

declare global {
  interface Window {
    __audios: HTMLMediaElement[]
  }
}

/** Records every media element that starts playing, so tests can assert on real playback. */
export async function trackAudio(page: Page) {
  await page.addInitScript(() => {
    window.__audios = []
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!window.__audios.includes(this)) window.__audios.push(this)
      return play.call(this)
    }
  })
}

export const playing = (page: Page) =>
  page.evaluate(() => {
    const el = window.__audios.at(-1)
    return el ? { src: el.currentSrc, time: el.currentTime, paused: el.paused } : null
  })

export async function seriousViolations(page: Page) {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; impact: string; nodes: { html: string }[] }[] }> } }).axe
    const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 80)).join(' | ')}`)
  })
}
