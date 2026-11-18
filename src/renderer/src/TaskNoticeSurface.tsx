import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskNotice } from '@shared/runner'
import { Icon } from './Icon'
import { StateMark } from './StateMark'

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
  // Also when the card changes with nothing drawn again: a typeface that arrives after the words were laid out wraps them
  // differently, and a window sized for the first layout would cut the buttons off.
  useEffect(() => {
    const shown = card.current
    if (!shown) return
    // Not once the card is gone: taken off the page it has no height, and that is not a height to ask for.
    const watch = new ResizeObserver(() => { if (shown.isConnected) api.sizeTaskNotice(Math.ceil(shown.getBoundingClientRect().height) + 24) })
    watch.observe(shown)
    return () => watch.disconnect()
  }, [id])

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

  // A command or a question of one line reads in the notice's own line, as the design writes it.
  const inline = !!notice.detail && (notice.detailKind === 'command' || notice.detailKind === 'question') && !notice.detail.includes('\n')
  return (
    <div className="task-notice-frame">
      <div ref={card} className="task-notice" role="alertdialog" aria-label={`${notice.title}. ${notice.where} ${notice.says}`} data-kind={notice.kind}>
        <div className="task-notice-head">
          <StateMark kind={notice.kind === 'done' ? 'done' : notice.kind === 'failed' ? 'failed' : 'waiting'} still />
          <strong>{notice.title}</strong>
          {notice.danger && <span className="task-danger" title={notice.danger}>Dangerous</span>}
        </div>
        <p className="task-notice-says">
          {notice.where} {notice.says}
          {inline && <> {notice.detailKind === 'command' ? <code className={notice.danger ? 'danger' : undefined}>{notice.detail}</code> : notice.detail}</>}
        </p>
        {notice.detail && !inline && <pre className={`task-notice-detail ${notice.detailKind}`}>{notice.detail}</pre>}
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
          <button className="small" onClick={() => api.openTaskFromNotice(notice.key)}>
            Open
          </button>
        </div>
      </div>
    </div>
  )
}
