/** Seconds → `m:ss` or `h:mm:ss`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** ISO timestamp → localized date, or '' when missing/invalid. */
export function formatDate(iso?: string): string {
  const d = iso ? new Date(iso) : undefined
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
}
