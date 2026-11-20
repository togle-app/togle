import { useRef, useState } from 'react'
import { answerCodexQuestion, type CodexQuestion } from '@shared/codex-questions'
import { useKeptState } from './kept'

/** Each question has its own reply, independent of the task's ordinary message box. */
export function CodexQuestions({ taskKey, questions, onSend }: {
  taskKey: string
  questions: CodexQuestion[]
  onSend: (words: string) => Promise<string | null>
}) {
  const storageKey = `codex-followups:${taskKey}`
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const ids: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    } catch { return [] }
  })
  const pending = questions.filter(q => !dismissed.includes(q.id))
  const dismiss = (id: string): void => {
    const next = [...dismissed, id].slice(-256)
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Kept in this window. */ }
    setDismissed(next)
  }
  const question = pending[0]
  return question ? <Question key={question.id} taskKey={taskKey} question={question} count={pending.length} onSend={onSend} onDone={() => dismiss(question.id)} /> : null
}

function Question({ taskKey, question, count, onSend, onDone }: {
  taskKey: string
  question: CodexQuestion
  count: number
  onSend: (words: string) => Promise<string | null>
  onDone: () => void
}) {
  const [answer, setAnswer] = useKeptState('codex-answer:' + JSON.stringify([taskKey, question.id]), '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sending = useRef(false)
  const submit = async (): Promise<void> => {
    if (!answer.trim() || sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const failed = await onSend(answerCodexQuestion(question, answer.trim()))
      if (failed) setError(failed)
      else { setAnswer(''); onDone() }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send your answer.') }
    finally { sending.current = false; setBusy(false) }
  }
  return (
    <form className="task-request codex-questions" aria-label="Codex follow-up questions" onSubmit={event => { event.preventDefault(); void submit() }}>
      <h3>{count === 1 ? 'Codex has a question' : `Codex has ${count} questions`}</h3>
      <p>{question.title}</p>
      {question.options.length > 0 && <div className="task-options">{question.options.map((option, index) =>
        <button key={index} type="button" className="small" aria-pressed={answer === option} disabled={busy} onClick={() => setAnswer(option)}>{option}</button>
      )}</div>}
      <input aria-label="Your answer to Codex" placeholder="Your answer" value={answer} onChange={event => setAnswer(event.target.value)} disabled={busy} />
      <div className="row">
        <button className="primary small" disabled={!answer.trim() || busy}>{busy ? 'Sending…' : 'Reply'}</button>
        <button type="button" className="small" disabled={busy} onClick={() => { setAnswer(''); onDone() }}>Skip</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  )
}
