import { useToasts } from '../state/toast'
import { Icon } from './Icon'

/** Polite live region; errors use role=alert so they are announced immediately. */
export function ToastRegion() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass-overlay${t.kind === 'error' ? ' toast--error' : ''}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <span>{t.message}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss notification" title="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
    </div>
  )
}
