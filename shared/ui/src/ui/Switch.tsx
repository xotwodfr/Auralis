/** An on/off switch (the phone UI's toggle). `label` is its accessible name; show visible text next to it. */
export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="m-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}
