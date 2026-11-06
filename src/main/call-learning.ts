import { createHash, randomUUID } from 'node:crypto'
import type { Agent, CallLearningResult, CallReview, CallSession, Lessons, LearningSource } from '@shared/types'
import { emptyLessons, joinLessons, lessonCount, selectLessons } from '@shared/learning'
import { LEARNING_VERSION } from '@shared/agent-learning'
import type { CallSessions } from './call-sessions'
import { splitReview } from './agents/trust'
import { withGeneratedTitle } from '@shared/call-title'

interface LearningAccess {
  agent(id: string): Agent
  review(session: CallSession): Promise<CallReview>
  apply(id: string, lessons: Lessons, auto: boolean, source?: LearningSource): Promise<Agent>
  summary?(session: CallSession, review: CallReview): Promise<void>
}

type Reviewed = CallLearningResult & CallReview
const lessonsOf = (review: Lessons): Lessons => ({ facts: review.facts, answers: review.answers, skills: review.skills, updates: review.updates, forget: review.forget })

/** One review per call revision. Only safe additions self-apply; user decisions use the persisted proposal. */
export class CallLearning {
  private locks = new Map<string, Promise<unknown>>()
  private reviews = new Map<string, Promise<Reviewed>>()
  constructor(private sessions: CallSessions, private access: LearningAccess) {}

  isBusy(id: string): boolean { return this.locks.has(id) }

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const task = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.locks.set(id, task)
    void task.then(() => { if (this.locks.get(id) === task) this.locks.delete(id) }, () => { if (this.locks.get(id) === task) this.locks.delete(id) })
    return task
  }

  review(id: string): Promise<Reviewed> {
    const running = this.reviews.get(id)
    if (running) return running
    const task = this.serial(id, () => this.run(id))
    this.reviews.set(id, task)
    void task.then(() => this.reviews.delete(id), () => this.reviews.delete(id))
    return task
  }

  private async run(id: string): Promise<Reviewed> {
    const session = await this.sessions.get(id)
    if (!session) throw new Error('This call is no longer available.')
    if (session.status === 'live') throw new Error('End this call before reviewing what it taught the agent.')
    if (!session.transcript.length && !session.callAnswers.length) throw new Error('No transcript or corrections were saved for this call.')
    let agent = this.access.agent(session.agentId)
    if (agent.id !== session.agentId) throw new Error('This call’s agent was deleted.')
    const sourceKey = createHash('sha256').update(JSON.stringify([LEARNING_VERSION, session.transcript, session.callAnswers.map(answer => [answer.question, answer.answer]), session.brief])).digest('hex')
    if (session.learning.state === 'reviewed' && session.learning.sourceKey === sourceKey) return { ...emptyLessons(), agentId: agent.id, session, agent }
    await this.sessions.update(id, latest => ({ ...latest, learning: { ...latest.learning, state: 'reviewing', error: undefined } }))
    try {
      const review = await this.access.review(session)
      if (review.agentId !== session.agentId) throw new Error('This review belongs to a different agent.')
      if (!await this.sessions.get(id)) throw new Error('This call was deleted.')
      agent = this.access.agent(session.agentId)
      if (agent.id !== session.agentId) throw new Error('This call’s agent was deleted.')
      const checked = splitReview(lessonsOf(review), agent, session.callAnswers)
      let safe = checked.keep
      let pending = joinLessons(review.check ?? emptyLessons(), checked.check)
      const previous = new Set(agent.history.map(change => change.id))
      if (agent.learning === 'auto') {
        if (lessonCount(safe)) agent = await this.access.apply(agent.id, safe, true, { kind: 'call', callId: session.id, at: session.endedAt ?? session.startedAt })
      } else pending = joinLessons(safe, pending)
      const added = agent.history.filter(change => !previous.has(change.id)).map(({ id, text }) => ({ id, text }))
      const updated = await this.sessions.update(id, latest => ({
        ...withGeneratedTitle(latest, review.title),
        summary: latest.minutes ? latest.summary : review.record?.summary || latest.summary,
        learning: { state: 'reviewed', reviewId: randomUUID(), reviewedAt: Date.now(), sourceLines: session.transcript.length, sourceKey, pending, changes: [...latest.learning.changes, ...added] }
      }))
      await this.access.summary?.(updated, review).catch(error => console.warn('[call summary]', (error as Error).message))
      return { ...review, session: updated, agent }
    } catch (error) {
      await this.sessions.update(id, latest => ({ ...latest, learning: { ...latest.learning, state: 'error', error: (error as Error).message } })).catch(() => undefined)
      throw error
    }
  }

  approve(id: string, reviewId: string, selected: string[]): Promise<CallLearningResult> {
    return this.serial(id, async () => {
      const record = await this.proposal(id, reviewId)
      const { kept, rest } = selectLessons(record.learning.pending, selected)
      if (!lessonCount(kept)) throw new Error('Select at least one lesson to keep.')
      const before = this.access.agent(record.agentId)
      if (before.id !== record.agentId) throw new Error('This call’s agent was deleted.')
      const known = new Set(before.history.map(change => change.id))
      const agent = await this.access.apply(record.agentId, kept, false, { kind: 'call', callId: record.id, at: record.endedAt ?? record.startedAt })
      const added = agent.history.filter(change => !known.has(change.id)).map(({ id, text }) => ({ id, text }))
      const session = await this.sessions.update(id, latest => ({ ...latest, learning: { ...latest.learning, pending: rest, reviewId: randomUUID(), changes: [...latest.learning.changes, ...added] } }))
      return { session, agent }
    })
  }

  dismiss(id: string, reviewId: string): Promise<CallSession> {
    return this.serial(id, async () => {
      await this.proposal(id, reviewId)
      return this.sessions.update(id, latest => ({ ...latest, learning: { ...latest.learning, pending: emptyLessons(), reviewId: randomUUID() } }))
    })
  }

  private async proposal(id: string, reviewId: string): Promise<CallSession> {
    const record = await this.sessions.get(id)
    if (!record) throw new Error('This call was deleted.')
    if (!record.learning.reviewId || record.learning.reviewId !== reviewId) throw new Error('These lessons have changed. Review the current list again.')
    return record
  }
}
