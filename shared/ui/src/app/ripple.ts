// M3 touch ripple: one delegated listener instead of a wrapper around every button.
const TARGETS = '.btn, .icon-btn:not(.icon-btn--main), .navitem, .segmented__item, .chip, .fold__summary, .m-tab, .m-chip, .m-row, .menu__item, .choice, .m-set__head, .m-set__row--button, .m-quick__item, .m-browse__tile, .m-tile a, .m-song__main, .m-mini__open, .m-play'

export function installRipple(root: HTMLElement = document.body) {
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const host = (e.target as Element | null)?.closest<HTMLElement>(TARGETS)
    if (!host || host.matches(':disabled')) return
    const box = host.getBoundingClientRect()
    const dot = document.createElement('span')
    dot.className = 'md-ripple'
    dot.setAttribute('aria-hidden', 'true')
    dot.style.left = `${e.clientX - box.left}px`
    dot.style.top = `${e.clientY - box.top}px`
    dot.style.setProperty('--d', `${Math.hypot(box.width, box.height) * 2}px`)
    host.classList.add('md-ripple-host')
    host.appendChild(dot)
    dot.addEventListener('animationend', () => dot.remove(), { once: true })
  })
}
