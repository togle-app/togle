import { useEffect, useRef, useState } from 'react'
import type { TodoOffer } from '@shared/call-todo'
import type { TodoList } from '@shared/todo'

export function MeetingTodo({ offer, onReviewed }: { offer: TodoOffer; onReviewed: (list: TodoList) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const review = async (action: 'add' | 'dismiss'): Promise<void> => {
    setBusy(true)
    setError('')
    try { onReviewed(await window.togle.reviewMeetingTodo(offer.callId, offer.text, action)) }
    catch (caught) { setError((caught as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    finally { setBusy(false) }
  }
  return <div className="todo-row" role="listitem" title={offer.title}>
    <span className="todo-grow todo-offer">{offer.text.replace(/\.$/, '')}</span>
    <button className="small" disabled={busy} onClick={() => void review('add')}>Add</button>
    <button className="small ghost" disabled={busy} onClick={() => void review('dismiss')}>Dismiss</button>
    {error && <span className="error" role="alert">{error}</span>}
  </div>
}

export function MeetingTodos({ callId, summary }: { callId: string; summary: string }) {
  const [items, setItems] = useState<TodoOffer[]>([])
  const read = useRef(0)
  useEffect(() => {
    const refresh = (): void => {
      const version = ++read.current
      void window.togle.meetingOffers(callId).then(found => { if (version === read.current) setItems(found.items) }, () => {})
    }
    refresh()
    const off = window.togle.onTodoChanged(refresh)
    return () => { ++read.current; off() }
  }, [callId, summary])
  if (!items.length) return null
  return <section className="todo-group meeting-suggestions" aria-label="Suggested to-dos">
    <h4 className="tasks-label">Suggested to-dos</h4>
    <div role="list">{items.map(offer => <MeetingTodo key={offer.text} offer={offer} onReviewed={() => setItems(previous => previous.filter(item => item.text !== offer.text))} />)}</div>
  </section>
}
