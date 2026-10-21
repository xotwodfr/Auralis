const TICK_MS = 8
const TICKS = '.m-tab, .m-play, .m-chip, .m-switch, .segmented__item, .transport button, .m-mini__toggle, input[type="checkbox"]'

/** A short system-style tick on the controls that change state (the Android WebView needs the VIBRATE permission for it). */
export function installHaptics() {
  if (!navigator.vibrate) return
  document.addEventListener(
    'click',
    (e) => {
      if ((e.target as Element).closest(TICKS)) navigator.vibrate(TICK_MS)
    },
    true,
  )
}
