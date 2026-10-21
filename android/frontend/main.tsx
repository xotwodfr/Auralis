import { applyTheme } from '@auralis/ui/app/theme'
import { startApp } from '@auralis/ui/bootstrap'
import MobileApp from './mobile/MobileApp'
import './mobile.css'
import './m3-mobile.css'

// The phone UI has one look (mobile.css, scoped to this attribute), so the theme pickers are skipped.
document.documentElement.dataset.platform = 'mobile'
applyTheme('dark')

startApp({ shell: MobileApp, mobile: true })
