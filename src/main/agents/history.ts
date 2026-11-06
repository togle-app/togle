import { lineEdit, undoLines } from '@shared/edit'
import { skillPurpose } from '@shared/agent-learning'
import type { Agent, AgentPatch, ApprovedAnswer, SessionHome, SetupField, Skill, TrainingChange } from '@shared/types'

type Change = TrainingChange['change']

/** The setup fields, by what Train calls them in its change lines ("Updated instructions"). */
const SETUP: { field: SetupField; label: string }[] = [
  { field: 'name', label: 'name' },
  { field: 'description', label: "what it's for" },
  { field: 'instructions', label: 'instructions' },
  { field: 'aboutMe', label: 'About me' },
  { field: 'vocabulary', label: 'words to recognize' }
]
// The setup fields as an Undo that can't be done says them (there's no page of them: the user tells the agent).
const SAID: Record<SetupField, string> = {
  name: 'name',
  description: "description of what it's for",
  instructions: 'instructions',
  aboutMe: 'what it knows about you',
  vocabulary: 'words to recognize'
}
// Fields of a line each (a rule, a fact about me): a change to one is undone line by line, even after later ones.
const BY_LINE = new Set<SetupField>(['instructions', 'aboutMe', 'vocabulary'])

/** Where its work sessions come from, as its change line says it. */
export const homesText = (homes: SessionHome[]): string =>
  `Work sessions from: ${homes.length ? homes.map((h) => h.name).join(', ') : 'all your Claude Code, Codex and exported chats'}`
// Agents saved before they had their own have none.
const homesKey = (homes: SessionHome[] | undefined): string => (homes ?? []).map((h) => h.dir.toLowerCase()).sort().join('\n')
/** The same Claude Code and Codex, in any order. */
export const sameHomes = (a: SessionHome[] | undefined, b: SessionHome[] | undefined): boolean => homesKey(a) === homesKey(b)

const sameSkill = (a: Skill, b: Skill): boolean => a.name === b.name && a.when === b.when && a.how === b.how && skillPurpose(a) === skillPurpose(b)
const sameAnswer = (a: ApprovedAnswer, b: ApprovedAnswer): boolean => a.question === b.question && a.answer === b.answer
const sameQuestion = (a: ApprovedAnswer, b: ApprovedAnswer): boolean => a.question.toLowerCase() === b.question.toLowerCase()

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
/** Two facts about the same thing: most of the shorter one's words are in the other ("Scale is 29 euros" → "35 euros"). */
function alike(a: string, b: string): boolean {
  const x = words(a)
  const y = words(b)
  const shared = [...x].filter((w) => y.has(w)).length
  return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.5
}

/**
 * The facts that went and came. Facts both lists have keep their order (memory is only ever added to, rewritten
 * in place or thinned), so between two of them, one that went and one alike it that came is a fact rewritten;
 * the rest were forgotten or are new.
 */
function factChanges(before: string[], after: string[]): { before?: string; after?: string }[] {
  const both = new Set(before.filter((fact) => after.includes(fact)))
  const out: { before?: string; after?: string }[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    const went: string[] = []
    while (i < before.length && !both.has(before[i])) went.push(before[i++])
    const came: string[] = []
    while (j < after.length && !both.has(after[j])) came.push(after[j++])
    for (const fact of went) {
      const rewritten = came.findIndex((other) => alike(fact, other))
      out.push(rewritten < 0 ? { before: fact } : { before: fact, after: came.splice(rewritten, 1)[0] })
    }
    for (const fact of came) out.push({ after: fact })
    // Past the fact both have, on both sides.
    i++
    j++
  }
  return out
}

/** What changed in an agent's training (setup, skills, approved answers, memory), each in a line as Train says it. */
export function changesBetween(before: Agent, after: Agent): { text: string; change: Change }[] {
  const out: { text: string; change: Change }[] = []
  for (const { field, label } of SETUP) {
    if (before[field] !== after[field]) out.push({ text: `Updated ${label}`, change: { kind: 'field', field, before: before[field], after: after[field] } })
  }
  if (!sameHomes(before.workHomes, after.workHomes)) {
    out.push({ text: homesText(after.workHomes), change: { kind: 'homes', before: before.workHomes ?? [], after: after.workHomes } })
  }

  const oldSkills = new Map(before.skills.map((s) => [s.id, s]))
  const newSkills = new Set(after.skills.map((s) => s.id))
  for (const skill of after.skills) {
    const was = oldSkills.get(skill.id)
    if (!was) out.push({ text: `Added skill: ${skill.name}`, change: { kind: 'skill', after: skill } })
    else if (!sameSkill(was, skill)) out.push({ text: `Updated skill: ${skill.name}`, change: { kind: 'skill', before: was, after: skill } })
  }
  for (const skill of before.skills) if (!newSkills.has(skill.id)) out.push({ text: `Removed skill: ${skill.name}`, change: { kind: 'skill', before: skill } })

  // A new answer to a question that had one takes its place: that answer changed.
  const oldAnswers = new Map(before.answers.map((a) => [a.id, a]))
  const newAnswers = new Set(after.answers.map((a) => a.id))
  const gone = before.answers.filter((a) => !newAnswers.has(a.id))
  for (const answer of after.answers) {
    const replaced = oldAnswers.has(answer.id) ? undefined : gone.find((g) => sameQuestion(g, answer))
    const was = oldAnswers.get(answer.id) ?? replaced
    if (replaced) gone.splice(gone.indexOf(replaced), 1)
    if (!was) out.push({ text: `Added approved answer: ${answer.question}`, change: { kind: 'answer', after: answer } })
    else if (!sameAnswer(was, answer)) out.push({ text: `Updated approved answer: ${answer.question}`, change: { kind: 'answer', before: was, after: answer } })
  }
  for (const answer of gone) out.push({ text: `Removed approved answer: ${answer.question}`, change: { kind: 'answer', before: answer } })

  for (const fact of factChanges(before.memory, after.memory)) {
    const text = fact.before === undefined ? `Remembered: ${fact.after}` : fact.after === undefined ? `Forgot: ${fact.before}` : `Updated fact: ${fact.after}`
    out.push({ text, change: { kind: 'fact', ...fact, ...(fact.before && before.factSources?.[fact.before] ? { beforeSource: before.factSources[fact.before] } : {}), ...(fact.after && after.factSources?.[fact.after] ? { afterSource: after.factSources[fact.after] } : {}) } })
  }
  return out
}

/**
 * What puts a change back: the item as it was, when the agent still has it as the change left it (a rule or a fact
 * about me, the lines it added, even after later ones). Otherwise says what's in the way, for the user to tell the
 * agent what it should be.
 */
export function undoPatch(agent: Agent, change: Change): AgentPatch {
  switch (change.kind) {
    case 'field': {
      const now = agent[change.field]
      if (now === change.after) return { [change.field]: change.before }
      const undone = BY_LINE.has(change.field) ? undoLines(now, lineEdit(change.before, change.after)) : null
      if (undone !== null) return { [change.field]: undone }
      throw new Error(
        BY_LINE.has(change.field) || change.field === 'vocabulary'
          ? `The ${SAID[change.field]} changed since. Tell me what to take out, and I'll do it.`
          : `The ${SAID[change.field]} changed since. Tell me what it should be, and I'll change it.`
      )
    }
    case 'homes': {
      if (!sameHomes(agent.workHomes, change.after)) throw new Error('Where its work sessions come from changed since; pick them where you give it a session.')
      return { workHomes: change.before }
    }
    case 'skill': {
      const { before, after } = change
      // The skill as the change left it, if the agent still has it.
      const now = after && agent.skills.find((s) => s.id === after.id)
      if (now && !sameSkill(now, after!)) throw new Error(`The skill "${now.name}" changed since. Tell me how it should be, and I'll change it.`)
      const rest = now ? agent.skills.filter((s) => s !== now) : agent.skills
      if (!before) return now ? { skills: rest } : {}
      if (rest.some((s) => s.id === before.id)) return now ? { skills: rest } : {}
      if (rest.some((s) => s.name.toLowerCase() === before.name.toLowerCase())) {
        throw new Error(`There's a skill named "${before.name}" now. Tell me to remove or rename it first.`)
      }
      // Back in its place when the change only rewrote it.
      return { skills: now ? agent.skills.map((s) => (s === now ? before : s)) : [...rest, before] }
    }
    case 'answer': {
      const { before, after } = change
      const now = after && agent.answers.find((a) => a.id === after.id)
      if (now && !sameAnswer(now, after!)) throw new Error(`The answer to "${now.question}" changed since. Tell me what it should say.`)
      const rest = now ? agent.answers.filter((a) => a !== now) : agent.answers
      if (!before) return now ? { answers: rest } : {}
      if (rest.some((a) => a.id === before.id)) return now ? { answers: rest } : {}
      if (rest.some((a) => sameQuestion(a, before))) throw new Error(`"${before.question}" has another answer now. Tell me to remove it first.`)
      return { answers: [...rest, before] }
    }
    case 'fact': {
      const { before, after } = change
      if (after !== undefined) {
        const at = agent.memory.indexOf(after)
        if (at < 0) {
          if (before === undefined || agent.memory.includes(before)) return {}
          throw new Error('That fact changed since. Tell me what it should say.')
        }
        const memory = [...agent.memory]
        if (before === undefined) memory.splice(at, 1)
        else memory[at] = before
        return { memory: [...new Set(memory)] }
      }
      return agent.memory.includes(before!) ? {} : { memory: [...agent.memory, before!] }
    }
  }
}
