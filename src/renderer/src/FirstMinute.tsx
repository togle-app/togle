import { useEffect, useState } from 'react'
import type { TaskView } from '@shared/runner'

const api = window.togle

export function FirstMinute({ onOpenTask, onDone }: { onOpenTask: (key: string) => void; onDone: () => void }) {
  const [tasks, setTasks] = useState<TaskView[]>()
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    let active = true
    let request = 0
    const read = () => {
      const current = ++request
      void api.runnerTasks().then(found => { if (active && current === request) { setTasks(found); setError('') } }, () => {
        if (active && current === request) { setTasks([]); setError('Couldn’t read the tasks on this computer.') }
      })
    }
    const stop = api.onRunnersChanged(read)
    read()
    return () => { active = false; stop() }
  }, [])
  const task = tasks?.[0]
  const start = async () => {
    setOpening(true)
    try { await api.openTaskBox({}); onDone() }
    catch (failure) { setError((failure as Error).message); setOpening(false) }
  }
  return (
    <section className="first-minute" aria-label="Getting started">
      <h2>{task ? 'Your agent tasks' : 'Start with a task'}</h2>
      {tasks === undefined ? <p role="status">Looking for tasks on this computer…</p> : <>
        {task && <p>{task.title}</p>}
        <div className="row">
          {task && <button className="primary" onClick={() => { onOpenTask(task.key); onDone() }}>Open task</button>}
          <button className={task ? '' : 'primary'} disabled={opening} onClick={() => void start()}>New task</button>
          <button className="ghost" onClick={onDone}>Go to To-do</button>
        </div>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}
