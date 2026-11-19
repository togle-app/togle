import type { PlanItem } from './runner'

/** The most finished items an agent's checklist keeps: the latest ones, so that what was just done shows. */
export const PLAN_DONE_KEPT = 8
/** The most items still to do that it keeps: the latest ones. What is being done is always kept. */
export const PLAN_OPEN_KEPT = 40

/**
 * An agent's checklist, kept short as its session goes on. A session that runs for days adds items to its checklist, finishes them
 * and rarely clears it: it can reach a thousand, in every step of the conversation that shows it. What was finished long ago is of no
 * use to anyone, so only the latest finished items stay. What is being done stays, and so does what is still to do, up to the latest
 * forty (an item the agent left to do that long ago is one it forgot). The order is kept. `finishedAt` says which finished item is
 * later (their place in the list, when it is not given).
 */
export function tidyPlan<T extends PlanItem>(plan: readonly T[], finishedAt: (item: T, index: number) => number = (_, index) => index): T[] {
  if (plan.length <= PLAN_DONE_KEPT) return [...plan]
  const entries = plan.map((item, index) => ({ item, index }))
  const finished = entries.filter(({ item }) => item.state === 'done').sort((a, b) => finishedAt(b.item, b.index) - finishedAt(a.item, a.index))
  const kept = new Set(
    [...finished.slice(0, PLAN_DONE_KEPT), ...entries.filter(({ item }) => item.state === 'doing'), ...entries.filter(({ item }) => item.state === 'todo').slice(-PLAN_OPEN_KEPT)].map(({ index }) => index)
  )
  return plan.filter((_, index) => kept.has(index))
}
