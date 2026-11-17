import { useEffect, useState } from 'react'
import type { ViewRequest } from '@shared/runner'

/** How long a card waits, after an answer was pressed, before its buttons can be pressed again (when the agent did not take it). */
const PRESSED_MS = 4_000

/**
 * What an agent waits for, as a card: a question with its choices, or a command or a change to allow once or refuse (a command
 * that looks dangerous is marked, and is never offered for always). Shown on the task, and on a call for an agent asked there.
 */
export function RequestCard({ request, onAllow, onAlways, onRefuse, onReply }: { request: ViewRequest; onAllow: () => void; onAlways: () => void; onRefuse: () => void; onReply: (text: string) => void }) {
  // What was pressed: it says so at once, and the card takes no second answer while the agent takes this one. The card goes
  // when the agent has it; if it is still here after a while (it was not taken), it can be answered again.
  const [pressed, setPressed] = useState<string>()
  useEffect(() => {
    if (!pressed) return
    const timer = setTimeout(() => setPressed(undefined), PRESSED_MS)
    return () => clearTimeout(timer)
  }, [pressed])
  const press = (what: string, answer: () => void) => () => {
    if (pressed) return
    setPressed(what)
    answer()
  }
  if (request.kind === 'question') {
    const questions = request.questions ?? []
    return (
      <section className="task-request" aria-label="The agent asks you">
        <h3>Asks</h3>
        {questions.map((question) => (
          <div key={question.id}>
            <p>{question.text}</p>
            {question.options.length > 0 && (
              <div className="task-options">
                {/* The first choice is the light one, as the design draws a question's choices. */}
                {question.options.map((option, index) => (
                  <button key={option} className={index === 0 ? 'primary small' : 'small'} disabled={!!pressed} aria-busy={pressed === option || undefined} onClick={press(option, () => onReply(option))}>
                    {option}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    )
  }
  const edit = request.kind === 'edit'
  return (
    <section className={`task-request ${request.danger ? 'danger' : ''}`} aria-label={edit ? 'The agent wants to change files' : 'The agent wants to run a command'}>
      <h3>
        {edit ? 'Wants to change' : 'Wants to run'}
        {request.danger && <span className="task-danger" title={request.danger}>Dangerous</span>}
      </h3>
      {edit ? (
        <ul className="task-files">
          {(request.files ?? []).map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      ) : (
        <pre className="task-command">{request.command}</pre>
      )}
      <div className="row">
        <button className="primary small" disabled={!!pressed} onClick={press('allow', onAllow)}>
          {pressed === 'allow' ? 'Allowing…' : 'Allow once'}
        </button>
        <button className="small" disabled={!!pressed} onClick={press('refuse', onRefuse)}>
          {pressed === 'refuse' ? 'Refusing…' : 'Refuse'}
        </button>
      </div>
      {/* What always reaches, in the agent's terms; never for a command that looks dangerous. */}
      {request.always && !request.danger && (<button className="task-always" disabled={!!pressed} onClick={press('always', onAlways)}>{pressed === 'always' ? 'Allowing…' : request.always}</button>)}
    </section>
  )
}
