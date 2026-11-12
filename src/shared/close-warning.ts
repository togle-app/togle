/** What would stop if Togle quit now, told to the window so it can ask first. */
export interface CloseWarning {
  /** A call, a recording or dictation is on. */
  call: boolean
  /** The names of the tasks Togle runs that have not finished: working, or waiting for the person. */
  tasks: string[]
}

const named = (title: string): string => `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`

/** The question Togle asks before it quits, in words that say what stops. */
export function quitQuestion(warning: CloseWarning): string {
  const count = warning.tasks.length
  if (!count) return 'Quit Togle? Writing down the call and dictation will stop. What was said so far is saved.'
  const tasks = count === 1 ? `${named(warning.tasks[0])} has not finished` : `${count} tasks have not finished`
  if (!warning.call) return `Quit Togle? ${tasks}. Quitting stops ${count === 1 ? 'it' : 'them'}. You can continue ${count === 1 ? 'it' : 'them'} from Agents.`
  return `Quit Togle? Writing down the call and dictation will stop, and so will ${count === 1 ? 'a task' : `${count} tasks`} that ${count === 1 ? 'has' : 'have'} not finished. What was said so far is saved.`
}
