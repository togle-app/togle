import { KNOWN_AGENTS, type TaskView } from '@shared/runner'
import { agentMarkOf, type AgentDrawing } from './agent-marks'

/** The name an agent goes by: an added agent's own, else the known name of its program. */
export const agentOf = (task: Pick<TaskView, 'runner' | 'agent'>): string => task.agent ?? KNOWN_AGENTS[task.runner] ?? task.runner

const letterOf = (name: string): string => name.trim().charAt(0).toUpperCase() || '?'

function Drawing({ mark }: { mark: AgentDrawing }) {
  if ('src' in mark) {
    if (mark.monochrome) return <i aria-hidden="true" className="agent-glyph agent-mask" style={{ maskImage: `url("${mark.src}")` }} />
    return <img className="agent-glyph" alt="" aria-hidden="true" src={mark.src} draggable={false} />
  }
  return (
    <svg className="agent-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" fillRule="evenodd">
      {mark.paths.map((d, index) => <path key={index} d={d} />)}
    </svg>
  )
}

/** Compact rows show the logo with an accessible name and tooltip. A custom agent with no logo keeps its name visible. */
export function AgentMark({ runner, name, quiet = false }: { runner?: string; name: string; quiet?: boolean }) {
  const mark = agentMarkOf(runner, name)
  if (!mark) {
    return (
      <span className="agent-mark">
        {/* Its letter is drawn by the style, so it is not in the line's text. */}
        <span className="agent-letter" data-letter={letterOf(name)} aria-hidden="true" />
        {name}
      </span>
    )
  }
  return (
    <span className={quiet ? 'agent-mark quiet' : 'agent-mark'} data-agent={mark.id} title={quiet ? name : undefined}>
      <Drawing mark={mark} />
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
  const mark = agentMarkOf(runner, name)
  return <span className="av" aria-hidden="true" data-agent={mark?.id}>{mark ? <Drawing mark={mark} /> : letterOf(name)}</span>
}
