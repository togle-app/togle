import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { Menu } from './Menu'

export interface ChoiceOption<T extends string = string> {
  value: T
  label: string
  /** A few words more, under it in the list. */
  note?: string
}

/** What a button that opens something shows: its words, and a small arrow that says it opens. */
export function Opens({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="choice-value">{children}</span>
      <Icon name="chevron" size={12} />
    </>
  )
}

/**
 * A setting with a few choices (a microphone, a language, where tasks open): what is chosen, on a button with a small
 * arrow, which opens the choices in Togle's own list with the one in use ticked. A long list opens on the one in use, and
 * a letter goes to the next choice that starts with it. `label` names it for the keys, a screen reader and the tests.
 * Its row is not its label: a press on the row's name would press the button, and close and open the list again.
 */
export function Choice<T extends string>({ label, title, value, options, disabled, onChange }: { label: string; title?: string; value: T; options: ChoiceOption<T>[]; disabled?: boolean; onChange: (value: T) => void }) {
  const current = options.find((option) => option.value === value)?.label ?? value
  return (
    <Menu
      className="choice"
      choice
      name={label}
      ariaLabel={`${label}: ${current}`}
      title={title}
      align="right"
      disabled={disabled}
      label={<Opens>{current}</Opens>}
      items={options.map((option) => ({ label: option.label, note: option.note, checked: option.value === value, onSelect: () => { if (option.value !== value) onChange(option.value) } }))}
    />
  )
}
