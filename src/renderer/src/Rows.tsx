import type { ReactNode } from 'react'

// The parts a page of settings is made of, as Settings has them and the other pages that set something (sharing an
// agent): a card of rows, each a setting with its control on the right, switches for what's on or off.

/**
 * A part of a page: its name (with how it's doing, for one that may not be ready), its settings together in a card,
 * and a line under them.
 */
export function Section({ id, title, state, note, children }: { id?: string; title: string; state?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id}>
      <div className="section-head">
        <h3 tabIndex={id ? -1 : undefined}>{title}</h3>
        {state}
      </div>
      <div className="card">{children}</div>
      {note && <p className="card-note">{note}</p>}
    </section>
  )
}

interface RowProps {
  name: ReactNode
  /** A line under its name, where it helps to choose: what it does, or what it costs. */
  note?: ReactNode
  children?: ReactNode
  /** A field as wide as the row, under its name (a key, an address). */
  stacked?: boolean
  /** Around a field, the row is its label (a click on the name goes to it); around buttons, it isn't. */
  label?: boolean
  className?: string
}

/** A setting: what it is on the left, with a line on it, and its control on the right (or under it, `stacked`). */
export function Row({ name, note, children, stacked, label = true, className = '' }: RowProps) {
  const Tag = label ? 'label' : 'div'
  const control = children !== undefined && <span className="control">{children}</span>
  return (
    <Tag className={`setting ${stacked ? 'stacked' : ''} ${note ? 'noted' : ''} ${className}`}>
      <span className="name">{name}</span>
      {stacked && control}
      {note && <span className="note">{note}</span>}
      {!stacked && control}
    </Tag>
  )
}

/** An on/off setting: its row, with a switch. */
export function Toggle({ name, note, checked, disabled, onChange }: { name: ReactNode; note?: ReactNode; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <Row name={name} note={note}>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  )
}
