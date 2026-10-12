import type { ReactNode } from 'react'

/** Responsive grid; children are `<li>`. Off-screen cards skip layout/paint via CSS `content-visibility`. */
export function Grid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul className="grid" aria-label={label}>
      {children}
    </ul>
  )
}
