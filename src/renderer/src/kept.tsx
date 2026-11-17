import { useEffect, useState } from 'react'

/**
 * What the window read last from Togle's main process, kept while its place is not on show: the window draws one place at a
 * time, and a place drawn again starts from nothing. A place opened again shows the last answer at once and reads again
 * behind it, so that nothing on it empties and fills in while you look.
 */
const answers = new Map<string, unknown>()

/** The agents found on this computer (runners:status), kept by the Agents screen and by Settings alike. */
export const AGENTS_FOUND = 'agents.status'

export function keptAnswer<T>(name: string): T | undefined {
  return answers.get(name) as T | undefined
}

export function keepAnswer<T>(name: string, value: T): void {
  answers.set(name, value)
}

/** Whether a wait has lasted longer than `ms`: a wait shorter than that shows no sign, so that a quick answer does not blink. */
export function useLongWait(waiting: boolean, ms = 150): boolean {
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
 * The sign that something is on its way: a thin moving line along the top of the place it is for (which is positioned), and
 * words for a screen reader. It comes only after a short wait, and is laid over the place, so nothing moves when it comes or
 * goes. `words`, when given, are shown under the line too, quietly.
 */
export function WaitLine({ waiting, label, words }: { waiting: boolean; label: string; words?: string }) {
  const long = useLongWait(waiting)
  if (!long) return null
  return (
    <>
      <div className="wait-line" role="progressbar" aria-label={label} />
      {words && <p className="wait-words">{words}</p>}
    </>
  )
}
