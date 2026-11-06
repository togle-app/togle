import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

/** Native modality keeps focus inside a picker and restores it to the control that opened it. */
export function PickerDialog({ title, onClose, initialFocus = 'input', children }: { title: string; onClose: () => void; initialFocus?: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLElement>(initialFocus)?.focus()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [initialFocus])
  return createPortal(<dialog ref={dialog} className="picker-dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const box = event.currentTarget.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose()
    }}>
    <div className="picker-dialog-head"><h2>{title}</h2><button type="button" className="icon" aria-label="Close picker" onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>, document.body)
}
