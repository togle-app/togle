import { useEffect, useRef, useState } from 'react'

/**
 * What the window read last from Togle's main process, kept while its place is not on show: the window draws one place at a
 * time, and a place drawn again starts from nothing. A place opened again shows the last answer at once and reads again
 * behind it, so that nothing on it empties and fills in while you look.
 */
const answers = new Map<string, unknown>()

/** The agents found on this computer (runners:status), kept by the Agents screen and by Settings alike. */
export const AGENTS_FOUND = 'agents.status'
/** The tasks on this computer (runners:list), kept by the Agents screen and read by the window from its start. */
export const TASKS_LISTED = 'agents.tasks'

export function keptAnswer<T>(name: string): T | undefined {
  return answers.get(name) as T | undefined
}

export function keepAnswer<T>(name: string, value: T): void {
  answers.set(name, value)
}

/** Whether a wait has lasted longer than `ms`: a wait shorter than that shows no sign, so that a quick answer does not blink. */
export function useLongWait(waiting: boolean, ms: number): boolean {
  const [long, setLong] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setLong(false)
      return
    }
    const timer = setTimeout(() => setLong(true), ms)
    return () => clearTimeout(timer)
  }, [waiting, ms])
  return waiting && long
}

/**
 * Whether a sign is shown: from `after` ms into a wait, and then for `atLeast` ms even when the wait ends sooner, so that it
 * does not blink on and off.
 */
function useSteadySign(waiting: boolean, after: number, atLeast: number): boolean {
  const [shown, setShown] = useState(false)
  const since = useRef(0)
  useEffect(() => {
    if (waiting) {
      if (shown) return
      const timer = setTimeout(() => {
        since.current = Date.now()
        setShown(true)
      }, after)
      return () => clearTimeout(timer)
    }
    if (!shown) return
    const timer = setTimeout(() => setShown(false), Math.max(0, atLeast - (Date.now() - since.current)))
    return () => clearTimeout(timer)
  }, [waiting, shown, after, atLeast])
  return shown
}

/**
 * The sign that something is on its way: a thin moving line along the top of the place it is for (which is positioned), and
 * words for a screen reader. The line comes after a quarter of a second and stays at least a little while, so that it does
 * not blink; it is laid over the place, so nothing moves when it comes or goes. `words`, for a place with nothing in it yet,
 * come only when the wait is long, and go the moment it ends: they are in the middle of the place.
 */
export function WaitLine({ waiting, label, words }: { waiting: boolean; label: string; words?: string }) {
  const line = useSteadySign(waiting, 250, 400)
  const said = useLongWait(waiting, 800)
  return (
    <>
      {line && <div className="wait-line" role="progressbar" aria-label={label} />}
      {words && said && <p className="wait-words">{words}</p>}
    </>
  )
}
