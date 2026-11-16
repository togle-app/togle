// A task opened from anywhere in the window (the answer to a question asked on a call, for one): the window listens for it and
// shows the task on Agents.

const EVENT = 'togle:open-task'

export const openTaskFrom = (key: string): void => void window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: key }))

export function onOpenTaskFrom(open: (key: string) => void): () => void {
  const listener = (e: Event): void => open((e as CustomEvent<string>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
