/** How a task stands, as its mark shows it. */
export type MarkKind = 'working' | 'waiting' | 'done' | 'failed' | 'stopped' | 'resting'

/**
 * How a task stands, in a small mark whose shape says it without its color: a ring that turns while it works, a dot that calls
 * while it waits for you, a tick when it is done, an exclamation mark when an error stopped it, a square when it was stopped,
 * and an empty ring for a scheduled job between its runs. `still`: the dot does not call, where what waits is already in front
 * of the person. With less motion asked for, nothing moves (design.css).
 */
export function StateMark({ kind, still = false }: { kind: MarkKind; still?: boolean }) {
  return (
    <span className={`state-mark${still ? ' still' : ''}`} data-mark={kind} aria-hidden="true">
      {kind === 'done' && (
        <svg viewBox="0 0 14 14">
          <path d="M4.3 7.3l1.9 1.9 3.6-3.9" />
        </svg>
      )}
      {kind === 'failed' && (
        <svg viewBox="0 0 14 14">
          <path d="M7 4.1v3.5M7 9.9v.01" />
        </svg>
      )}
    </span>
  )
}
