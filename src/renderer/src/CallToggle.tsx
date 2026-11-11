/** A switch in the call's controls: its name ("Auto-suggest"; "Auto" in a narrow window), and on or off. */
export function CallToggle({ label, short, accessibleLabel, checked, disabled, title, onToggle }: {
  label: string; short?: string; accessibleLabel: string; checked: boolean; disabled?: boolean; title: string; onToggle: () => void
}) {
  return <button type="button" className={`auto-replies ${checked ? 'on' : ''}`} role="switch"
    aria-label={accessibleLabel} aria-checked={checked} disabled={disabled} title={title} onClick={onToggle}>
    <span className="auto-dot" aria-hidden="true" />
    {short ? <><span className="toggle-long">{label}</span><span className="toggle-short">{short}</span></> : label} {checked ? 'on' : 'off'}
  </button>
}
