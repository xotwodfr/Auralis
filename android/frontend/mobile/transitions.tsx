import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigationType, type Location } from 'react-router'

/** Material motion: top-level destinations fade through, deeper pages share an axis (forward in, back out). */
type Motion = 'tab' | 'forward' | 'back' | 'card'

const TAB_ROOTS = ['/home', '/search', '/library']
const isTabRoot = (path: string) => TAB_ROOTS.includes(path)
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const canMorph = () => !!document.startViewTransition && !reducedMotion()

const Shown = createContext<Location | null>(null)
export const ShownLocation = Shown.Provider
/** The location whose page is on screen. It trails the router's by one view transition, so the outgoing page keeps its own chrome. */
export function useShownLocation(): Location {
  const location = useContext(Shown)
  if (!location) throw new Error('useShownLocation needs <ShownLocation>')
  return location
}

const ART_WAIT_MS = 300

/** Resolves once the destination's hero art exists (its data has loaded), so the cover can morph into it; gives up after ART_WAIT_MS.
 *  A timer, not requestAnimationFrame: rendering is paused while a view transition waits for its update. */
const heroArt = () =>
  new Promise<void>((resolve) => {
    const start = performance.now()
    const poll = () => (document.querySelector('.m-hero__art, .m-player__art') || performance.now() - start > ART_WAIT_MS ? resolve() : setTimeout(poll, 16))
    poll()
  })

/** Runs `update` (which must commit its DOM changes synchronously, e.g. with flushSync) inside a view transition when the WebView has them and motion is allowed, else straight away. */
export function withTransition(motion: Motion, update: () => void | Promise<void>) {
  const root = document.documentElement
  if (!canMorph()) return update()
  root.dataset.motion = motion
  const transition = document.startViewTransition(update)
  void transition.finished.finally(() => {
    delete root.dataset.motion
    delete root.dataset.art
    delete root.dataset.card
    document.querySelectorAll<HTMLElement>('[data-vt]').forEach(unname)
  })
}

const name = (el: HTMLElement | null, as: string) => {
  if (!el) return
  el.style.viewTransitionName = as
  el.dataset.vt = ''
}
function unname(el: HTMLElement | null) {
  if (!el) return
  el.style.viewTransitionName = ''
  delete el.dataset.vt
}

/** Names a cover so the next page's hero art morphs out of it (container transform). Call from the tap handler. */
export function markArt(from: EventTarget | null) {
  const art = (from as Element | null)?.closest('a, button')?.querySelector<HTMLElement>('.artwork, .m-liked-art')
  if (!art) return
  if (!canMorph()) return
  name(art, 'm-art')
  document.documentElement.dataset.art = ''
}

/** Holds back the router's location until the outgoing page has been captured, so every navigation (links, Back, the hardware button) animates alike. */
export function useTransitionedLocation(target: Location): Location {
  const type = useNavigationType()
  const [shown, setShown] = useState(target)
  const scroll = useRef(new Map<string, number>())
  const pending = useRef(target.key)

  useEffect(() => {
    if (target.key === shown.key || target.key === pending.current) return
    pending.current = target.key
    scroll.current.set(shown.key, window.scrollY)
    const show = () => {
      flushSync(() => setShown(target))
      // Lists come back where they were left; new pages start at the top.
      window.scrollTo(0, type === 'POP' ? (scroll.current.get(target.key) ?? 0) : 0)
      // The old page stays frozen on screen meanwhile, which reads as the tap taking effect rather than as a flash of skeleton.
      return 'art' in document.documentElement.dataset ? heroArt() : undefined
    }
    if (target.pathname === shown.pathname) {
      show() // filters and tabs within one page: no page motion
      return
    }
    withTransition(isTabRoot(shown.pathname) && isTabRoot(target.pathname) ? 'tab' : type === 'POP' ? 'back' : 'forward', show)
  }, [target, shown, type])

  return shown
}

/** Now Playing is a container transform: the mini-player grows into the full player and shrinks back, whatever closed it (Close, Back, the hardware button). */
export function usePlayerPresence(open: boolean): boolean {
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open === shown) return
    const mini = () => document.querySelector<HTMLElement>('.m-mini')
    const player = () => document.querySelector<HTMLElement>('.m-player')
    const from = open ? mini() : player()
    if (canMorph()) {
      name(from, 'm-card')
      document.documentElement.dataset.card = open ? 'open' : 'close'
    }
    withTransition('card', () => {
      flushSync(() => setShown(open))
      if (!canMorph()) return
      unname(from)
      name(open ? player() : mini(), 'm-card')
    })
  }, [open, shown])
  return shown
}

/** Whether Now Playing animates itself in and out through a view transition (else it plays its own CSS enter/exit). */
export const playerMorphs = canMorph
