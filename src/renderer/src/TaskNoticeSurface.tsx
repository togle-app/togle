import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskNotice } from '@shared/runner'
import { Icon } from './Icon'

const api = window.togle

// A notice that has only just appeared cannot be answered at once: a click meant for what was under it must not allow a command.
const ARM_MS = 700

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The small window in the corner of the screen: a task waits for the person, or one finished. */
export function TaskNoticeSurface() {
  const [notice, setNotice] = useState<TaskNotice | null>(null)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const card = useRef<HTMLDivElement>(null)
  const id = notice?.id

  useEffect(() => api.onTaskNotice((next) => setNotice(next)), [])

  useEffect(() => {
    setArmed(false)
    setBusy(false)
    setError('')
    if (!id) return
    const timer = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(timer)
  }, [id])

  // The window is no taller than what is in it.
  useLayoutEffect(() => {
    if (card.current) api.sizeTaskNotice(Math.ceil(card.current.getBoundingClientRect().height) + 24)
  })

  if (!notice) return null

  const answer = async (decision: 'allow-once' | 'refuse'): Promise<void> => {
    if (!notice.requestId || busy) return
    setBusy(true)
    setError('')
    try {
      await api.answerRunnerTask(notice.key, notice.requestId, decision)
    } catch (caught) {
      setError(errorText(caught))
      setBusy(false)
    }
  }

  return (
    <div className="task-notice-frame">
      <div ref={card} className="task-notice" role="alertdialog" aria-label={`${notice.title}. ${notice.where} ${notice.says}`} data-kind={notice.kind}>
        <div className="task-notice-head">
          <span className="task-notice-dot" aria-hidden="true" />
          <strong>{notice.title}</strong>
          <button className="icon" aria-label="Close notice" title="Close" onClick={() => api.dismissTaskNotice(notice.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
        <p className="task-notice-says">
          {notice.where} {notice.says}
        </p>
        {notice.detail && <pre className={`task-notice-detail ${notice.detailKind}`}>{notice.detail}</pre>}
        {notice.danger && (
          <p className="task-notice-danger">
            <span className="task-danger">Dangerous</span> {notice.danger}
          </p>
        )}
        {error && <p className="task-notice-error" role="alert">{error}</p>}
        <div className="task-notice-actions">
          {notice.canAllow && (
            <button className="primary small" disabled={!armed || busy} onClick={() => void answer('allow-once')}>
              Allow once
            </button>
          )}
          {notice.canRefuse && (
            <button className="small" disabled={busy} onClick={() => void answer('refuse')}>
              Refuse
            </button>
          )}
          <button className="ghost small" onClick={() => api.openTaskFromNotice(notice.key)}>
            Open
          </button>
        </div>
        {!notice.canAllow && notice.canRefuse && (
          <p className="task-notice-note">{notice.danger ? 'It looks dangerous, so it is allowed in the Togle window, not here.' : 'Not all of it fits here. Open it to read all of it before you allow it.'}</p>
        )}
        {notice.others > 0 && <p className="task-notice-more">{notice.others === 1 ? '1 other task waits' : `${notice.others} other tasks wait`}</p>}
      </div>
    </div>
  )
}
