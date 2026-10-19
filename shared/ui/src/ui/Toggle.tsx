import { isMobileApp } from '../app/platform'
import { Switch } from './Switch'

/** An on/off setting with its visible label: the web app's checkbox, the phone UI's switch (each screen keeps its idiom). */
export function Toggle({ label, checked, disabled, onChange, className = '', labelClassName = '' }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; className?: string; labelClassName?: string }) {
  return isMobileApp() ? (
    <span className={`toggle ${className}`}>
      <span className={labelClassName}>{label}</span>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </span>
  ) : (
    <label className={`check ${className}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={labelClassName}>{label}</span>
    </label>
  )
}
