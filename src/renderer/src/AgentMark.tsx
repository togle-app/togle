import { KNOWN_AGENTS, type TaskView } from '@shared/runner'
import { AGENT_MARKS } from './agent-marks'

/** The name an agent goes by: an added agent's own, else the known name of its program. */
export const agentOf = (task: Pick<TaskView, 'runner' | 'agent'>): string => task.agent ?? KNOWN_AGENTS[task.runner] ?? task.runner

/**
 * The paths of an agent's mark, or none for an agent the person added. `runner` says which one it is; a task on another device
 * has only the agent's name, which is looked up among the known ones.
 */
function marksOf(runner: string | undefined, name: string): { key?: string; paths?: readonly string[] } {
  const key = runner !== undefined ? runner : Object.keys(KNOWN_AGENTS).find((known) => KNOWN_AGENTS[known] === name)
  return { key, paths: key ? AGENT_MARKS[key] : undefined }
}
const letterOf = (name: string): string => name.trim().charAt(0).toUpperCase() || '?'

function Drawing({ paths }: { paths: readonly string[] }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" fillRule="evenodd">
      {paths.map((d, index) => <path key={index} d={d} />)}
    </svg>
  )
}

/**
 * An agent's mark, to say which program something belongs to: its maker's own mark for Claude Code, Codex and Hermes Agent
 * (agent-marks.ts), in the color of the text around it; for an agent the person added, its first letter in a box.
 *
 * `quiet`: the mark alone, where a line is short. Its name stays as the tooltip and for screen readers (and in the text of the
 * line). An agent the person added always shows its name after its letter: two can share one.
 */
export function AgentMark({ runner, name, quiet = false }: { runner?: string; name: string; quiet?: boolean }) {
  const { key, paths } = marksOf(runner, name)
  if (!paths) {
    return (
      <span className="agent-mark">
        {/* Its letter is drawn by the style, so it is not in the line's text. */}
        <span className="agent-letter" data-letter={letterOf(name)} aria-hidden="true" />
        {name}
      </span>
    )
  }
  return (
    <span className={quiet ? 'agent-mark quiet' : 'agent-mark'} data-agent={key} title={quiet ? name : undefined}>
      <Drawing paths={paths} />
      {quiet ? <span className="sr-only">{name}</span> : name}
    </span>
  )
}

/** The first thing in a line that says which agent: its mark, then what follows after a dot (the mark alone has no dot after it). */
export function AgentLead({ runner, name, rest }: { runner?: string; name: string; rest?: string }) {
  return (
    <>
      <AgentMark runner={runner} name={name} quiet />
      {rest ? <><span className="agent-dot"> · </span>{rest}</> : null}
    </>
  )
}

/** The square an agent has in a list of agents (Settings, the first minute): its mark, or its first letter. Its name is beside it. */
export function AgentAvatar({ runner, name }: { runner: string; name: string }) {
  const { paths } = marksOf(runner, name)
  return <span className="av" aria-hidden="true" data-agent={paths ? runner : undefined}>{paths ? <Drawing paths={paths} /> : letterOf(name)}</span>
}
