import type { Agent, CallAnswer, Lessons } from '@shared/types'
import { skillPurpose } from '@shared/agent-learning'

// What speech recognition mishears, and what may hold for one customer only: an amount, a price, a deal.
const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|a dozen'
const UNITS =
  'seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?|seats?|users?|licen[cs]es?|people|employees|percent|per cent|euros?|dollars?|pounds?|cents?'
const AMOUNT = new RegExp(`\\d+(?:[.,]\\d+)?|\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*\\s+(?:${UNITS})\\b`, 'gi')
const DEAL = /[€$£%]|\b(?:euros?|dollars?|usd|eur|gbp|percent|discounts?|free|prices?|pricing|costs?|fees?|refunds?|rebates?|guarantee[ds]?|deadlines?|contracts?)\b/i

/** The amounts a text says ("35", "two months", "forty percent"). */
const amounts = (text: string): string[] => (text.match(AMOUNT) ?? []).map((a) => a.toLowerCase().replace(/[\s-]+/g, ' '))

/**
 * What a call review may keep on its own, and what waits for a yes even when the agent learns on its own:
 * - a change to what it knows (a fact rewritten or forgotten, a rule of a skill reworded), as Hermes Agent's background
 *   review stages its changes and removals of memory, whatever the user set;
 * - an amount, price or deal taken from the call: speech recognition mishears numbers, and what I offered one customer
 *   isn't what I'd say to every one. One the agent already has (in its memory, answers, skills or setup), or that I
 *   approved or corrected on this call (`noted`), is sure.
 * The answers I approved or corrected are mine: kept as given.
 */
export function splitReview(lessons: Lessons, agent: Agent, noted: CallAnswer[]): { keep: Lessons; check: Lessons } {
  const known = new Set(
    amounts([...agent.memory, ...agent.answers.map((a) => a.answer), ...agent.skills.map((s) => s.how), agent.aboutMe, agent.instructions, ...noted.map((a) => a.answer)].join('\n'))
  )
  const sure = (text: string): boolean => {
    const said = amounts(text)
    if (!said.length) return !DEAL.test(text)
    return said.every((a) => known.has(a))
  }
  const mine = new Map(noted.map((a) => [a.question.toLowerCase(), a.answer]))
  const keep: Lessons = { facts: [], answers: [], skills: [], updates: [], forget: [] }
  const check: Lessons = { facts: [], answers: [], skills: [], updates: [...lessons.updates], forget: [...lessons.forget] }
  for (const fact of lessons.facts) (sure(fact) ? keep : check).facts.push(fact)
  for (const qa of lessons.answers) (mine.get(qa.question.toLowerCase()) === qa.answer ? keep : check).answers.push(qa)
  for (const skill of lessons.skills) {
    if (skill.purpose === 'assistance' && !skill.source?.feedbackIds?.length) { check.skills.push(skill); continue }
    // A skill it has, improved: its lines added are new, a line of it gone was reworded.
    const had = agent.skills.find((s) => s.name.toLowerCase() === skill.name.toLowerCase() && skillPurpose(s) === (skill.purpose ?? 'reference'))?.how.split('\n')
    const lines = skill.how.split('\n')
    const reworded = !!had?.some((line) => line.trim() && !lines.includes(line))
    const added = had ? lines.filter((line) => !had.includes(line)).join('\n') : skill.how
    ;(!reworded && sure(added) ? keep : check).skills.push(skill)
  }
  return { keep, check }
}

/** Whether a set of lessons has anything in it. */
export const anyLessons = (lessons: Lessons): boolean => Object.values(lessons).some((list) => list.length > 0)
