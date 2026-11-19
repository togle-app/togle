import type { ReactNode } from 'react'
import { DELIVERY_WORDS, type Delivery } from '@shared/sent-messages'

/**
 * How far a message the person sent has got, as a chat app draws it: a clock while it is being sent, one tick when it was handed to the
 * agent, two grey ticks when the agent has it (in its own queue), two ticks in the accent when the agent took it in, and a red mark
 * when it could not be sent. It says the same in words (the tooltip and the screen reader).
 */
export function Ticks({ state, title }: { state: Delivery; title?: string }): ReactNode {
  return (
    <span className="ticks" data-state={state} role="img" aria-label={DELIVERY_WORDS[state]} title={title ?? DELIVERY_WORDS[state]}>
      {state === 'sending' && (
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.2" />
          <path d="M7 4.2V7l2 1.3" />
        </svg>
      )}
      {state === 'sent' && (
        <svg viewBox="0 0 18 14" aria-hidden="true">
          <path d="M5.5 7.6l3.2 3.2 6.3-7.4" />
        </svg>
      )}
      {(state === 'delivered' || state === 'taken') && (
        <svg viewBox="0 0 18 14" aria-hidden="true">
          <path d="M1.5 7.6l3.2 3.2 6.3-7.4" />
          <path d="M7.6 10.4l.5.5 6.9-7.5" />
        </svg>
      )}
      {state === 'failed' && (
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.2" />
          <path d="M7 4.2v3.5M7 9.9v.01" />
        </svg>
      )}
    </span>
  )
}
