import { lineEdit } from '@shared/edit'
import type { Agent } from '@shared/types'
import { skillPurpose } from '@shared/agent-learning'

const counted = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** The rules it was taught since it was set up: changes to its instructions that added lines, not undone. */
function rulesTaught(agent: Agent): number {
  return agent.history.filter((h) => {
    if (h.undone || h.origin === 'manual' || h.change.kind !== 'field' || h.change.field !== 'instructions' || !h.change.before.trim()) return false
    const { added, removed } = lineEdit(h.change.before, h.change.after)
    return added.length > 0 && !removed.length
  }).length
}

/**
 * What an agent was taught, in a line: "2 rules · about you · 3 skills · 12 facts · 4 documents" (what it has none
 * of left out).
 */
export function taught(agent: Agent): string {
  const rules = rulesTaught(agent)
  return [
    rules ? counted(rules, 'rule') : '',
    agent.aboutMe.trim() ? 'about you' : '',
    agent.skills.some(skill => skillPurpose(skill) === 'assistance') ? counted(agent.skills.filter(skill => skillPurpose(skill) === 'assistance').length, 'skill') : '',
    agent.skills.some(skill => skillPurpose(skill) === 'reference') ? counted(agent.skills.filter(skill => skillPurpose(skill) === 'reference').length, 'reference note') : '',
    agent.answers.length ? counted(agent.answers.length, 'answer') : '',
    agent.memory.length ? counted(agent.memory.length, 'fact') : '',
    agent.knowledge.length ? counted(agent.knowledge.length, 'document') : ''
  ]
    .filter(Boolean)
    .join(' · ')
}
