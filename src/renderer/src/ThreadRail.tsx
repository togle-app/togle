import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { Prompt } from './TaskThread'

/** How far under the top of the conversation a question's turn may begin and still be the one being read. */
const SLACK = 8
/** The room the conversation keeps under its line (its top padding): a turn taken to the top is put there, not at the line. */
const roomOf = (box: HTMLElement): number => parseFloat(getComputedStyle(box).paddingTop) || 0
/** The most of a question its tip shows. */
const TIP_LENGTH = 160
const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const cut = (text: string, longest: number): string => (text.length <= longest ? text : `${text.slice(0, longest - 1).trimEnd()}…`)

/**
 * A rail at the right edge of the conversation with a tick for each question the person asked: the one being read is lit,
 * the pointer (or the keys) on a tick shows its question in a tip beside it, and a press takes the conversation to that
 * question. It is meant for a long conversation: the parent shows it from the third question on.
 */
export function ThreadRail({ prompts, log, onEarlier, onLeaveEnd }: { prompts: Prompt[]; log: RefObject<HTMLDivElement | null>; onEarlier?: () => void; onLeaveEnd: () => void }) {
  const rail = useRef<HTMLElement>(null)
  const ticks = useRef<HTMLDivElement>(null)
  // The question being read, by the conversation's scroll; a pressed one keeps the light while its turn is in view and until the
  // person scrolls on their own (near the end the conversation cannot be scrolled far enough to put a late question at its top).
  const [read, setRead] = useState(0)
  const [picked, setPicked] = useState<number | null>(null)
  const pickedKey = useRef<number | null>(null)
  pickedKey.current = picked
  const [tip, setTip] = useState<{ top: number; text: string; at?: number } | null>(null)

  const measure = useCallback((): void => {
    const box = log.current
    if (!box) return
    const tops = new Map<number, number>()
    for (const turn of box.querySelectorAll<HTMLElement>('[data-turn]')) tops.set(Number(turn.dataset.turn), turn.offsetTop)
    // A pressed question whose turn has gone out of view (the conversation was taken somewhere else) is let go of.
    const turn = pickedKey.current === null ? null : box.querySelector<HTMLElement>(`[data-turn="${pickedKey.current}"]`)
    if (pickedKey.current !== null && (!turn || turn.offsetTop + turn.offsetHeight <= box.scrollTop || turn.offsetTop >= box.scrollTop + box.clientHeight)) setPicked(null)
    const line = box.scrollTop + SLACK + roomOf(box)
    let at = 0
    prompts.forEach((prompt, index) => {
      const top = tops.get(prompt.key)
      if (top !== undefined && top <= line) at = index
    })
    // At the very end the last question is the one being read, whatever fits under it.
    if (box.scrollHeight > box.clientHeight + 4 && box.scrollHeight - box.scrollTop - box.clientHeight < 4) at = prompts.length - 1
    setRead(at)
  }, [log, prompts])

  useLayoutEffect(measure, [measure])
  useEffect(() => {
    const box = log.current
    if (!box) return
    let frame = 0
    const soon = (): void => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    // The person scrolling (wheel, touch, a press on the bar or the words) lets go of a pressed question.
    const free = (): void => setPicked(null)
    box.addEventListener('scroll', soon, { passive: true })
    box.addEventListener('wheel', free, { passive: true })
    box.addEventListener('touchmove', free, { passive: true })
    box.addEventListener('pointerdown', free)
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon)
    watch?.observe(box)
    return () => {
      cancelAnimationFrame(frame)
      box.removeEventListener('scroll', soon)
      box.removeEventListener('wheel', free)
      box.removeEventListener('touchmove', free)
      box.removeEventListener('pointerdown', free)
      watch?.disconnect()
    }
  }, [log, measure])

  const pickedAt = picked === null ? -1 : prompts.findIndex((prompt) => prompt.key === picked)
  const active = pickedAt >= 0 ? pickedAt : Math.min(read, prompts.length - 1)

  // A long conversation has more ticks than the rail is tall: the lit one is kept in view.
  useEffect(() => {
    const scroller = ticks.current
    const lit = scroller?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!scroller || !lit || scroller.scrollHeight <= scroller.clientHeight) return
    if (lit.offsetTop < scroller.scrollTop) scroller.scrollTop = lit.offsetTop
    else if (lit.offsetTop + lit.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = lit.offsetTop + lit.offsetHeight - scroller.clientHeight
  }, [active, prompts.length])

  const jump = (prompt: Prompt): void => {
    const box = log.current
    const turn = box?.querySelector<HTMLElement>(`[data-turn="${prompt.key}"]`)
    if (!box || !turn) return
    // Not at the newest words any more: what comes while it works does not take the person from the question.
    onLeaveEnd()
    setPicked(prompt.key)
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    box.scrollTo({ top: Math.max(0, turn.offsetTop - roomOf(box)), behavior: still ? 'auto' : 'smooth' })
  }

  const point = (button: HTMLElement, text: string, at?: number): void => {
    const nav = rail.current
    if (!nav) return
    const place = nav.getBoundingClientRect()
    const mark = button.getBoundingClientRect()
    // Beside its tick, kept inside the conversation's height.
    const top = Math.min(Math.max(mark.top + mark.height / 2 - place.top, 34), Math.max(34, place.height - 34))
    setTip({ top, text: cut(text, TIP_LENGTH), at })
  }

  const move = (event: KeyboardEvent<HTMLElement>): void => {
    const buttons = [...(ticks.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowUp' ? at - 1 : event.key === 'ArrowDown' ? at + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined
    if (next === undefined || at < 0) return
    event.preventDefault()
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus()
  }

  return (
    <nav
      ref={rail}
      className="thread-rail"
      aria-label="Your questions in this conversation"
      onKeyDown={move}
      onPointerLeave={() => setTip(null)}
      // Over the rail, the wheel scrolls the conversation as it does anywhere beside it.
      onWheel={(event) => {
        const scroller = ticks.current
        if (scroller && scroller.scrollHeight > scroller.clientHeight) return
        if (log.current) log.current.scrollTop += event.deltaY
      }}
    >
      <div className="rail-ticks" ref={ticks}>
        <div className="rail-track">
          {onEarlier && (
            <button type="button" className="rail-tick rail-earlier" aria-label="Show earlier turns" tabIndex={-1} onClick={onEarlier} onPointerEnter={(event) => point(event.currentTarget, 'Show earlier turns')} onPointerLeave={(event) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.rail-tick'))) setTip(null) }} onFocus={(event) => point(event.currentTarget, 'Show earlier turns')} onBlur={() => setTip(null)} />
          )}
          {prompts.map((prompt, index) => (
            <button
              key={prompt.key}
              type="button"
              className="rail-tick"
              aria-label={cut(prompt.text, 120)}
              aria-current={index === active ? 'location' : undefined}
              tabIndex={index === active ? 0 : -1}
              onClick={() => jump(prompt)}
              onPointerEnter={(event) => point(event.currentTarget, prompt.text, prompt.at)}
              // Off a tick, its tip goes (on to another tick, it goes there).
              onPointerLeave={(event) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.rail-tick'))) setTip(null) }}
              onFocus={(event) => point(event.currentTarget, prompt.text, prompt.at)}
              onBlur={() => setTip(null)}
            />
          ))}
        </div>
      </div>
      {tip && (
        <div className="rail-tip" style={{ top: tip.top }} aria-hidden="true">
          {tip.at !== undefined && <time dateTime={new Date(tip.at).toISOString()}>{timeOf(tip.at)}</time>}
          <span>{tip.text}</span>
        </div>
      )}
    </nav>
  )
}
