let mobile = false

/** Called once by a platform entry point before first render; the Android app turns the phone variants on. */
export function configurePlatform(options: { mobile: boolean }) {
  mobile = options.mobile
}

/** True in the Android app: shared components that have a phone variant (chips, toggles) pick it. */
export const isMobileApp = () => mobile
