import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

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
 * the right. `tall`: its name over a box of several lines. `note`: a line under it. `choice`: it holds a button that opens
 * choices, not a place to type, so it is not that button's label (a press on its name would press the button).
 */
export function Field({ name, note, tall, choice, children }: { name: string; note?: ReactNode; tall?: boolean; choice?: boolean; children: ReactNode }) {
  const Tag = choice ? 'div' : 'label'
  return (
    <>
      <Tag className={`field ${tall ? 'tall' : ''} ${choice ? 'has-choice' : ''}`} role={choice ? 'group' : undefined} aria-label={choice ? name : undefined}>
        <span className="field-name">{name}</span>
        {children}
      </Tag>
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

// The dialogs open now: the page under them does not scroll while there is one.
let dialogs = 0

/**
 * A form to type in (an agent to add, a key, a sign-in, a device's code), as a dialog: the card the design draws, in the
 * middle of the window and hung near its top (it does not shift when it grows a field), over the dimmed window. Nothing
 * on the page moves, and the button that opened it stays where it is. The keys go to its first field and stay in the form
 * (Tab from its last button goes to its first field); Escape closes it wherever the keys are, and they go back to the
 * button that opened it. A click beside it does not close it: what was typed stays. It is in the page where its group is
 * and only laid over the window, so that the rules and the names of its group still find it.
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
    if (++dialogs === 1) document.body.classList.add('has-dialog')
    // The keys go to the first field to type in (a choice already made, such as the service of a key, is not the first stop).
    const first = box?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ?? box?.querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && box && !event.defaultPrevented) {
        // The keys stay in the form: past its last stop they go to its first, and from outside it they come in.
        const stops = [...box.querySelectorAll<HTMLElement>('input, select, textarea, button')].filter((stop) => !stop.hasAttribute('disabled') && stop.tabIndex >= 0 && stop.getClientRects().length)
        const at = stops.indexOf(document.activeElement as HTMLElement)
        const to = event.shiftKey ? (at <= 0 ? stops.length - 1 : -1) : at < 0 || at === stops.length - 1 ? 0 : -1
        if (to >= 0 && stops[to]) { event.preventDefault(); stops[to].focus() }
        return
      }
      // Not the Escape that closes a list of choices: that list takes it first, and it never comes here.
      if (event.key !== 'Escape' || event.defaultPrevented || working.current) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', key)
    return () => {
      if (--dialogs === 0) document.body.classList.remove('has-dialog')
      document.removeEventListener('keydown', key)
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div className="form-backdrop" role="dialog" aria-modal="true" aria-label={label}>
      <form ref={form} className={`setting-detail over ${className}`} aria-label={label} onSubmit={(event) => { event.preventDefault(); onSubmit() }}>{children}</form>
    </div>
  )
}

/**
 * A picture shown whole over the dimmed window (one in a conversation, opened from its small one), as big as the window lets
 * it be. Escape, the close button, or a click beside the picture closes it, and the keys go back to what opened it; while it
 * is open they stay on its close button.
 */
export function PictureOver({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const closer = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (++dialogs === 1) document.body.classList.add('has-dialog')
    closer.current?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') { event.preventDefault(); closer.current?.focus(); return }
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', key)
    return () => {
      if (--dialogs === 0) document.body.classList.remove('has-dialog')
      document.removeEventListener('keydown', key)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div className="picture-backdrop" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => { if (event.target === event.currentTarget) close.current() }}>
      <img className="picture-whole" src={src} alt={label} />
      <button ref={closer} type="button" className="icon picture-close" aria-label="Close the picture" title="Close" onClick={() => close.current()}>
        <Icon name="close" />
      </button>
    </div>
  )
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
