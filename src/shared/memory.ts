import { MEMORY_LIMIT, type Lessons } from './types'

/** How much of the memory budget (MEMORY_LIMIT) facts take. */
export const memoryChars = (memory: string[]): number => memory.reduce((n, fact) => n + fact.length, 0)

/** Keep all saved facts; include a bounded selection in a live answer. Newer facts break relevance ties. */
export function memoryForContext(memory: string[], query = '', limit = MEMORY_LIMIT): string[] {
  if (memoryChars(memory) <= limit) return [...memory]
  const common = new Set('the and for you your our what when how was were with this that have has does did about from yesterday today update updates'.split(' '))
  const words = (text: string): string[] => [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !common.has(word)))]
  const terms = words(query)
  const ranked = memory.map((text, index) => {
    const tokens = new Set(words(text))
    return { text, index, score: terms.reduce((sum, term) => sum + Number(tokens.has(term)), 0) }
  }).sort((a, b) => b.score - a.score || b.index - a.index)
  let used = 0
  const selected = ranked.filter(item => {
    if (used + item.text.length > limit) return false
    used += item.text.length
    return true
  })
  return selected.sort((a, b) => a.index - b.index).map(item => item.text)
}

/**
 * Memory once kept lessons of a call review are applied: outdated facts dropped, changed ones rewritten in place,
 * new ones added, each fact once.
 */
export function memoryAfter(memory: string[], lessons: Pick<Lessons, 'facts' | 'updates' | 'forget'>): string[] {
  const forget = new Set(lessons.forget)
  const updates = new Map(lessons.updates.map((u) => [u.from, u.to.trim()]))
  const next = memory.filter((m) => !forget.has(m)).map((m) => updates.get(m) || m)
  for (const fact of lessons.facts) if (fact.trim()) next.push(fact.trim())
  return [...new Set(next)]
}

// Words too common to tell two rules apart.
const COMMON = new Set('the and you your they them their with for that this what are our but can will when then about from into'.split(' '))
// A rule and its opposite share most of their words: "Never offer a discount on the first call."
const NEGATION = /\b(never|not|no|don'?t|do not|avoid|without|isn'?t|aren'?t|won'?t|can'?t|cannot)\b/i
const ruleWords = (line: string): Set<string> => new Set((line.toLowerCase().match(/\p{L}{3,}|\p{N}+/gu) ?? []).filter((w) => !COMMON.has(w) && w !== 'not'))
/** A line of a skill as its words go, without its bullet. */
const plainLine = (line: string): string =>
  line
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!;:,]+$/, '')
    .toLowerCase()

/** Two lines that state one rule, one reworded: most of their words the same (numbers too), and both or neither saying "not". */
function sameRule(a: string, b: string): boolean {
  if (plainLine(a) === plainLine(b)) return true
  if (NEGATION.test(a) !== NEGATION.test(b)) return false
  const x = ruleWords(a)
  const y = ruleWords(b)
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common >= 3 && common / (x.size + y.size - common) >= 0.6
}

/**
 * How a skill reads once the call review improved it (`improved`: the review's lines for it): what it said stays as it
 * was written, a line the review reworded takes the place of the one it rewords, and new lines go at the end. Hermes
 * Agent patches a skill in place for this; given the whole skill to rewrite, the review dropped what the skill knew.
 * Within the limit, a rule it had is never dropped: a new or reworded line that doesn't fit is left out instead.
 */
export function skillAfter(how: string, improved: string, limit = 3000): string {
  const lines = how.split('\n')
  let changed = false
  for (const line of improved.split('\n').filter((l) => l.trim())) {
    const i = lines.findIndex((old) => old.trim() && sameRule(old, line))
    if (i >= 0 && plainLine(lines[i]) === plainLine(line)) continue
    const next = i >= 0 ? lines.map((old, j) => (j === i ? line : old)) : [...lines, line]
    if (next.join('\n').length > limit) continue
    lines.splice(0, lines.length, ...next)
    changed = true
  }
  return changed ? lines.join('\n') : how
}
