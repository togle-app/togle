import type { Agent } from '@shared/types'

const COLORS = ['#7c9cff', '#8fd3a6', '#f2b880', '#c3a6ff', '#ff9fb2', '#7fd4d0', '#e6d27a']

/** An agent's round picture: its initial, in a color of its own (as each of Hermes's bots has one). */
export function Avatar({ agent, size = 22 }: { agent: Pick<Agent, 'id' | 'name'>; size?: number }) {
  let hash = 0
  for (const ch of agent.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const color = COLORS[hash % COLORS.length]
  const initial = agent.name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '?'
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), color, background: `${color}22`, borderColor: `${color}55` }}
    >
      {initial}
    </span>
  )
}
