import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

// The parts a page of settings is made of, as Settings has them and the other pages that set something (sharing an
// agent): a card of rows, each a setting with its control on the right, switches for what's on or off.

/**
 * A part of a page: its name (with how it's doing, for one that may not be ready), its settings together in a card,
 * and a line under them.
 */
export function Section({ id, title, state, note, className, children }: { id?: string; title: string; state?: ReactNode; note?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={className}>
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

/**
 * A field as the design draws one: what it is and what is typed in it share one box, its name on the left and the words on
 * the right. `tall`: its name over a box of several lines. `note`: a line under it.
 */
export function Field({ name, note, tall, children }: { name: string; note?: ReactNode; tall?: boolean; children: ReactNode }) {
  return (
    <>
      <label className={`field ${tall ? 'tall' : ''}`}>
        <span className="field-name">{name}</span>
        {children}
      </label>
      {note && <span className="hint field-note">{note}</span>}
    </>
  )
}

/** One form over the page at a time: opening one closes the one that was open. Its state, and how to change it. */
export function useOneOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  const id = useId()
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('togle:form-open', { detail: id }))
    const another = (event: Event): void => { if ((event as CustomEvent).detail !== id) setOpen(false) }
    window.addEventListener('togle:form-open', another)
    return () => window.removeEventListener('togle:form-open', another)
  }, [open, id])
  return [open, setOpen]
}

/**
 * A form to type in (an agent to add, a key, a sign-in, a device's code): one card as wide as Settings, as the design draws
 * it, so that a command or an address has room. It opens under the button that opened it and over the page: nothing on the
 * page moves, and that button stays where it is. The keys go to its first field; Escape closes it wherever the keys are, and
 * they go back to the button that opened it. A click elsewhere does not close it: what was typed stays.
 */
export function FormOver({ label, className = '', busy = false, onClose, onSubmit, children }: { label: string; className?: string; busy?: boolean; onClose: () => void; onSubmit: () => void; children: ReactNode }) {
  const form = useRef<HTMLFormElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const working = useRef(busy)
  working.current = busy
  useEffect(() => {
    const box = form.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // In a low window the page moves just far enough to show it whole, buttons and all: as it opens, and again when it
    // grows (a field that a choice adds, a line that says what went wrong).
    const show = (): void => box?.scrollIntoView({ block: 'nearest' })
    show()
    const grown = new ResizeObserver(show)
    if (box) grown.observe(box)
    // The keys go to the first field to type in (a choice already made, such as the service of a key, is not the first stop).
    const first = box?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ?? box?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')
    first?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent): void => {
      // Not the Escape that closes a list of choices.
      if (event.key !== 'Escape' || event.defaultPrevented || working.current || event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', key)
    return () => {
      grown.disconnect()
      document.removeEventListener('keydown', key)
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus({ preventScroll: true })
    }
  }, [])
  return <form ref={form} className={`setting-detail over ${className}`} aria-label={label} onSubmit={(event) => { event.preventDefault(); onSubmit() }}>{children}</form>
}

/**
 * A ref for what a row opens in its place (a list, a question): when the window is too low to show it whole where it opened,
 * the page moves just far enough to show it, so that its buttons are never left under the window's edge.
 */
export const openedInView = (element: HTMLElement | null): void => { element?.scrollIntoView({ block: 'nearest' }) }

/** An on/off setting: its row, with a switch. */
export function Toggle({ name, note, checked, disabled, onChange }: { name: ReactNode; note?: ReactNode; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <Row name={name} note={note}>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  )
}
