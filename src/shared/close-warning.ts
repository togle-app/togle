/** What would stop, and what would go on, if Togle quit now, told to the window so it can ask first. */
export interface CloseWarning {
  /** A call, a recording or dictation is on. */
  call: boolean
  /** The names of the tasks Togle runs that have not finished and would stop: working, or waiting for the person. */
  tasks: string[]
  /** The names of the tasks in the background that are working or waiting for the person, and go on without Togle. */
  goesOn?: string[]
}

const named = (title: string): string => `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`

/** The question Togle asks before it quits, in words that say what stops and what goes on. */
export function quitQuestion(warning: CloseWarning): string {
  const count = warning.tasks.length
  const going = warning.goesOn ?? []
  const goes = going.length === 1 ? `${named(going[0])} is still going, and goes on without Togle. Togle finds it again when it starts.` : `${going.length} tasks are still going, and go on without Togle. Togle finds them again when it starts.`
  if (!count) {
    if (!warning.call) return going.length ? `Quit Togle? ${goes}` : 'Quit Togle?'
    return `Quit Togle? Writing down the call and dictation will stop. What was said so far is saved.${going.length ? ` ${goes}` : ''}`
  }
  const tasks = count === 1 ? `${named(warning.tasks[0])} has not finished` : `${count} tasks have not finished`
  if (!warning.call) return `Quit Togle? ${tasks}. Quitting stops ${count === 1 ? 'it' : 'them'}. You can continue ${count === 1 ? 'it' : 'them'} from Agents.${going.length ? ` ${goes}` : ''}`
  return `Quit Togle? Writing down the call and dictation will stop, and so will ${count === 1 ? 'a task' : `${count} tasks`} that ${count === 1 ? 'has' : 'have'} not finished. What was said so far is saved.${going.length ? ` ${goes}` : ''}`
}
