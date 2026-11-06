import type { LearningSource, Skill } from './types'

export const LEARNING_VERSION = 2

/** Learning a team's procedure does not make it an instruction to the assistant. */
export const skillPurpose = (skill: Partial<Pick<Skill, 'purpose' | 'origin'>>): 'assistance' | 'reference' =>
  skill.purpose === 'reference' || !skill.purpose && skill.origin === 'call' ? 'reference' : 'assistance'

export function sourceLabel(source?: LearningSource): string {
  if (!source || !Number.isFinite(source.at)) return 'Earlier context; source not recorded'
  return `${source.kind === 'call' ? 'Reported in a call' : 'Provided by you'} · ${new Date(source.at).toLocaleDateString()}`
}
