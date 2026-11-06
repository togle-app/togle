import { useEffect, useRef, useState } from 'react'
import { AnswerCard, applyAnswerEvent, type AnswerItem } from './AnswerCard'
import { Icon } from './Icon'

const api = window.togle

interface Props {
  agentId: string
  agentName: string
  /** The call's cards to ask again, oldest first. */
  asked: AnswerItem[]
  /** Asked for: until then it shows nothing (and asks nothing). */
  started: boolean
  onClose: () => void
}

/**
 * After the call review trained the agent, once asked to: the call's last questions asked again, each as it was at
 * that moment of the call (a suggestion or my own question, with its screenshot), beside what the agent answered
 * then. One quick answer each, one at a time.
 */
export function AskAgain({ agentId, agentName, asked, started, onClose }: Props) {
  // Each question's answer now, by its place in `asked`.
  const [replies, setReplies] = useState<(AnswerItem | undefined)[]>([])
  // Tells these answers apart from the ones tried in the agent's chat, which come through the same channel.
  const tag = useRef(`again-${crypto.randomUUID()}`)

  useEffect(() => {
    if (!started) return
    // The answer (by its id) to each question asked so far.
    const jobs = new Map<string, number>()
    // Those still being answered, and whether one was just asked and hasn't started yet.
    const open = new Set<string>()
    let waiting = false
    let closed = false
    let next = 0
    const askNext = (): void => {
      const i = next++
      const item = asked[i]
      if (!item || closed) return
      waiting = true
      api.testAgent(agentId, item.question, {
        asked: item.at,
        tag: `${tag.current}/${i}`,
        kind: item.kind === 'ask' ? 'ask' : 'suggest',
        withScreen: item.withScreen
      })
    }
    const unsubscribe = api.onAgentTest((event) => {
      if (event.type === 'start') {
        const [prefix, place] = event.again?.split('/') ?? []
        if (prefix !== tag.current) return
        waiting = false
        // Closed before it started: it's stopped as it starts.
        if (closed) {
          api.cancelAssist(event.id)
          unsubscribe()
          return
        }
        jobs.set(event.id, Number(place))
        open.add(event.id)
      }
      const i = jobs.get(event.id)
      if (i === undefined) return
      setReplies((prev) => {
        const copy = [...prev]
        copy[i] = applyAnswerEvent(copy[i] ? [copy[i]] : [], event, 1)[0]
        return copy
      })
      // The copilot streams one test answer at a time: the next question waits for this one.
      if ((event.type === 'done' || event.type === 'error') && event.part === 'main') {
        open.delete(event.id)
        askNext()
      }
    })
    askNext()
    // Closed, or the call cleared: what's still being answered stops (it would only use the plan).
    return () => {
      closed = true
      for (const id of open) api.cancelAssist(id)
      if (!waiting) unsubscribe()
    }
  }, [started])

  if (!started) return null
  // Each question once, what it answered then as a line (all of it, clicked), and its answer now.
  return (
    <article className="assist learn" aria-label={`How ${agentName} would answer now`}>
      <header>
        <span className="kind">How I'd answer now</span>
        <button className="dismiss" title="Close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </header>
      {asked.map((before, i) => (
        <div key={before.id} className="again">
          <p className="again-q">“{before.question}”</p>
          <div className="again-then">
            <span>Then:</span>
            {before.text ? <AnswerCard item={before} older asked={false} /> : <span>no answer.</span>}
          </div>
          {replies[i] ? <AnswerCard item={replies[i]} asked={false} /> : <p className="thinking">Waiting…</p>}
        </div>
      ))}
    </article>
  )
}
