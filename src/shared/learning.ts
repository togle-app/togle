import type { Lessons } from './types'

export const emptyLessons = (): Lessons => ({ facts: [], answers: [], skills: [], updates: [], forget: [] })
export const lessonCount = (lessons: Lessons): number => Object.values(lessons).reduce((sum, items) => sum + items.length, 0)
export function lessonItems(lessons: Lessons): { id: string; label: string }[] {
  return [
    ...lessons.facts.map((fact, i) => ({ id: `facts:${i}`, label: fact })),
    ...lessons.answers.map((answer, i) => ({ id: `answers:${i}`, label: `${answer.question} → ${answer.answer}` })),
    ...lessons.skills.map((skill, i) => ({ id: `skills:${i}`, label: `${skill.purpose === 'assistance' ? 'Assistance skill' : 'Reference'} — ${skill.name}: ${skill.how}` })),
    ...lessons.updates.map((update, i) => ({ id: `updates:${i}`, label: `Replace “${update.from}” with “${update.to}”` })),
    ...lessons.forget.map((fact, i) => ({ id: `forget:${i}`, label: `Forget: ${fact}` }))
  ]
}
