export function Skeleton() {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="skeleton__row" />
      ))}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {hint && <p className="empty__hint">{hint}</p>}
    </div>
  )
}

export function ErrorState({ message, onRetry, actionLabel = 'Try again' }: { message: string; onRetry: () => void; actionLabel?: string }) {
  return (
    <div className="empty" role="alert">
      <p className="empty__title">{message}</p>
      <button className="btn" type="button" onClick={onRetry}>
        {actionLabel}
      </button>
    </div>
  )
}
