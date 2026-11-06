export function CallToggle({ label, accessibleLabel, checked, disabled, title, onToggle }: {
  label: string; accessibleLabel: string; checked: boolean; disabled?: boolean; title: string; onToggle: () => void
}) {
  return <button type="button" className={`auto-replies ${checked ? 'on' : ''}`} role="switch"
    aria-label={accessibleLabel} aria-checked={checked} disabled={disabled} title={title} onClick={onToggle}>
    <span className="auto-dot" aria-hidden="true" />{label} {checked ? 'on' : 'off'}
  </button>
}
