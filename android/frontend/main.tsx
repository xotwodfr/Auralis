import { applyTheme } from '@auralis/ui/app/theme'
import { startApp } from '@auralis/ui/bootstrap'
import MobileApp from './mobile/MobileApp'
import { installHaptics } from './mobile/haptics'
import { DEFAULT_SEED, applyScheme } from './mobile/scheme'
import './mobile.css'

// The phone UI has one look (mobile.css, scoped to this attribute), so the theme pickers are skipped.
document.documentElement.dataset.platform = 'mobile'
applyTheme('dark') // shared lyric/contrast tokens; the colours come from the M3 scheme below
applyScheme(DEFAULT_SEED)

installHaptics()
startApp({ shell: MobileApp, mobile: true })
