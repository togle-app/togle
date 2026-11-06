import type { Lessons } from './types'

export const emptyLessons = (): Lessons => ({ facts: [], answers: [], skills: [], updates: [], forget: [] })
export const lessonCount = (lessons: Lessons): number => Object.values(lessons).reduce((sum, items) => sum + items.length, 0)
export const joinLessons = (a: Lessons, b: Lessons): Lessons => ({
  facts: [...a.facts, ...b.facts], answers: [...a.answers, ...b.answers], skills: [...a.skills, ...b.skills], updates: [...a.updates, ...b.updates], forget: [...a.forget, ...b.forget]
})
export function lessonItems(lessons: Lessons): { id: string; label: string }[] {
  return [
    ...lessons.facts.map((fact, i) => ({ id: `facts:${i}`, label: fact })),
    ...lessons.answers.map((answer, i) => ({ id: `answers:${i}`, label: `${answer.question} → ${answer.answer}` })),
    ...lessons.skills.map((skill, i) => ({ id: `skills:${i}`, label: `${skill.purpose === 'assistance' ? 'Assistance skill' : 'Reference'} — ${skill.name}: ${skill.how}` })),
    ...lessons.updates.map((update, i) => ({ id: `updates:${i}`, label: `Replace “${update.from}” with “${update.to}”` })),
    ...lessons.forget.map((fact, i) => ({ id: `forget:${i}`, label: `Forget: ${fact}` }))
  ]
}
export function selectLessons(lessons: Lessons, selected: string[]): { kept: Lessons; rest: Lessons } {
  const ids = new Set(selected)
  const kept = emptyLessons()
  const rest = emptyLessons()
  for (const key of ['facts', 'answers', 'skills', 'updates', 'forget'] as const) {
    // Each list retains its element type; selection never accepts new content from the renderer.
    Object.assign(kept, { [key]: lessons[key].filter((_, index) => ids.has(`${key}:${index}`)) })
    Object.assign(rest, { [key]: lessons[key].filter((_, index) => !ids.has(`${key}:${index}`)) })
  }
  return { kept, rest }
}
