import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { stepsLine, taskHandoffProblem, type CallAgents as CallAgentList, type GiveResult, type RunnerKind, type RunnerStatus, type TaskView } from '@shared/runner'
import { AgentLead, AgentMark, agentOf } from './AgentMark'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { projectFolderOf } from '@shared/task-groups'
import { useKeptState } from './kept'
import { Menu } from './Menu'
import { openTaskFrom } from './open-task'
import { RequestCard } from './RequestCard'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder
const RECENT_MS = 24 * 3600_000
const MOST_ROWS = 10

/** Where a task is and how it stands, after its agent: the folder, and working, waiting or idle. */
const whereRest = (task: TaskView): string => [task.folder ? baseName(projectFolderOf(task.folder)) : '', task.state === 'working' ? 'working' : task.state === 'waiting' ? 'waiting' : task.state === 'idle' ? 'idle' : task.state].filter(Boolean).join(' · ')
/** A task as a short name for a chip or a row: its words, and under them the agent and the folder. */
const where = (task: TaskView): string => [agentOf(task), whereRest(task)].filter(Boolean).join(' · ')

/**
 * Why a task cannot be sent a call now, in words, or nothing when it can. Togle sends to a task it runs; Claude Code and Hermes take
 * words on their screen only, when their turn has ended (Codex takes them while it works too).
 */
export function whyNotSent(task: TaskView): string | undefined {
  if (!task.mine) return task.pid ? 'It runs in your terminal' : 'Open it in Agents first'
  if (task.terminal && !task.screen) return 'It runs in a terminal of its own'
  if (task.signedOut) return 'It is signed out'
  if ((task.state === 'working' || task.state === 'waiting' || !!task.waitingFor) && task.runner !== 'codex') return task.state === 'waiting' ? 'It waits for you' : 'It is working'
  return undefined
}

/** The agent tasks on this computer, kept current, and whether they were asked for yet. */
function useTasks(): { tasks: TaskView[]; loaded: boolean } {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let live = true
    const read = (): void => { void api.runnerTasks().then((list) => { if (live) { setTasks(Array.isArray(list) ? list : []); setLoaded(true) } }, () => undefined) }
    read()
    const off = api.onRunnersChanged(read)
    const timer = setInterval(read, 5000)
    return () => { live = false; off(); clearInterval(timer) }
  }, [])
  return { tasks, loaded }
}

/** What giving a call did, in a line for each task that did not get it, and one for those that did. */
function resultLine(results: GiveResult[], tasks: TaskView[]): { ok: boolean; text: string } {
  const named = (result: GiveResult): string => {
    const task = tasks.find((item) => item.key === result.key)
    return result.title ?? (task ? `${task.title} (${agentOf(task)})` : result.key)
  }
  const sent = results.filter((result) => result.ok)
  const failed = results.filter((result) => !result.ok)
  const parts = [
    ...(sent.length ? [`Sent to ${sent.map(named).join(', ')}.`] : []),
    ...failed.map((result) => `${named(result)}: ${result.problem ?? 'not sent'}`)
  ]
  return { ok: !failed.length, text: parts.join(' ') }
}

/**
 * The agents on a call: the tasks connected to it, each ticked to get what is said, and Send (while the call goes on) to tell
 * the ticked ones where the call is saved. Connected before the call starts, during it, or after.
 */
export function CallAgentsRow({ call, live }: { call: string; live: boolean }) {
  const { tasks } = useTasks()
  const [agents, setAgents] = useState<CallAgentList>({ keys: [], sent: {} })
  // The ones left unticked, so that a task connected later is ticked from the start.
  const [unticked, setUnticked] = useKeptState<string[]>(`call-unticked:${call}`, NONE)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // A question for the agents on this call, and what was asked before on it (kept while the window is open).
  const [question, setQuestion] = useKeptState(`call-question:${call}`, '')
  const [asking, setAsking] = useState(false)
  const [asked, setAsked] = useState<Asked[]>(() => askedOn.get(call) ?? [])
  useEffect(() => {
    let current = true
    setAgents({ keys: [], sent: {} })
    setMessage(null)
    setAsked(askedOn.get(call) ?? [])
    void api.callAgents(call).then((found) => { if (current && found) setAgents(found) }, () => undefined)
    return () => { current = false }
  }, [call])
  const change = async (keys: string[]): Promise<void> => {
    try {
      setAgents(await api.setCallAgents(call, keys))
      // A task taken off the call, and put on again, is ticked again.
      setUnticked((previous) => previous.filter((key) => keys.includes(key)))
    } catch (failure) { setMessage({ ok: false, text: errorText(failure) }) }
  }
  const ticked = agents.keys.filter((key) => !unticked.includes(key))
  const send = async (): Promise<void> => {
    if (busy || !ticked.length) return
    setBusy(true); setMessage(null)
    try {
      setMessage(resultLine(await api.giveCall({ call, tasks: ticked, prompt: '' }), tasks))
      setAgents(await api.callAgents(call))
    } catch (failure) { setMessage({ ok: false, text: errorText(failure) }) } finally { setBusy(false) }
  }
  const keepAsked = (next: Asked[]): void => { askedOn.set(call, next); setAsked(next) }
  // The question goes to the ticked agents with where the call is saved so far. Those that could not take it are told in words, and
  // the question stays in the box when none could.
  const ask = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const words = question.trim()
    if (asking || !words || !ticked.length) return
    setAsking(true); setMessage(null)
    const at = Date.now()
    try {
      const results = await api.giveCall({ call, tasks: ticked, prompt: words })
      const took = results.filter((result) => result.ok).map((result) => result.key)
      const refused = results.filter((result) => !result.ok)
      if (refused.length) setMessage(resultLine(refused, tasks))
      if (took.length) { keepAsked([{ id: ++askedCount, question: words, at, keys: took }, ...(askedOn.get(call) ?? [])].slice(0, MOST_ASKS)); setQuestion('') }
      setAgents(await api.callAgents(call))
    } catch (failure) { setMessage({ ok: false, text: errorText(failure) }) } finally { setAsking(false) }
  }
  return (
    <div className="call-agents-wrap">
      <div className="call-agents" role="group" aria-label={live ? 'Agents on this call' : 'Agents for the next call'}>
        <span className="lab">{live ? 'Agents' : 'Agents for the next call'}</span>
        {agents.keys.map((key) => {
          const task = tasks.find((item) => item.key === key)
          return (
            <span key={key} className="agent-chip" title={task ? `${task.title} · ${where(task)}${agents.sent[key] ? ` · sent ${new Date(agents.sent[key]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` : 'That task is gone'}>
              {live && <input type="checkbox" aria-label={`Send to ${task?.title ?? 'this agent'}`} checked={!unticked.includes(key)} onChange={(event) => setUnticked((previous) => (event.target.checked ? previous.filter((item) => item !== key) : [...previous, key]))} />}
              <span className="cut">{task ? <AgentLead runner={task.runner} name={agentOf(task)} rest={task.folder ? baseName(projectFolderOf(task.folder)) : task.title} /> : 'Gone'}</span>
              <button type="button" className="ghost small" aria-label={`Take ${task?.title ?? 'this agent'} off the call`} onClick={() => void change(agents.keys.filter((item) => item !== key))}><Icon name="close" size={10} /></button>
            </span>
          )
        })}
        <button type="button" className="small" onClick={() => setAdding(!adding)} aria-expanded={adding}>Add</button>
        {live && !!agents.keys.length && <button type="button" className="primary small" disabled={busy || !ticked.length} title="Writes what was said so far to a file, and tells each ticked agent where it is" onClick={() => void send()}>{busy ? 'Sending…' : 'Send what was said'}</button>}
        {/* The list opens under this row, over the page: nothing under it moves. */}
        {adding && <GivePanel call={call} mode="connect" connected={agents.keys} onClose={() => setAdding(false)} onChanged={(next, keepOpen) => { setAgents(next); if (!keepOpen) setAdding(false) }} />}
      </div>
      {live && !!agents.keys.length && (
        <form className="call-ask" onSubmit={(event) => void ask(event)} aria-label="Ask the agents about this call">
          <input value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} aria-label="Ask the agents about this call" placeholder="Ask the agents about this call, or hold F9 and say it" />
          <button className="primary small" disabled={asking || !question.trim() || !ticked.length} title={ticked.length ? 'Sends the question and where the call is saved so far to each ticked agent' : 'Tick an agent to ask'}>{asking ? 'Asking…' : 'Ask'}</button>
        </form>
      )}
      {message && <p className={message.ok ? 'hint' : 'error'} role="status">{message.text}</p>}
      {live && asked.map((entry) => (
        <div key={entry.id} className="call-asked">
          {entry.keys.map((key) => (
            <CallAnswer key={key} asked={entry} task={tasks.find((item) => item.key === key)} taskKey={key} onDismiss={() => keepAsked((askedOn.get(call) ?? []).map((one) => (one.id === entry.id ? { ...one, keys: one.keys.filter((other) => other !== key) } : one)).filter((one) => one.keys.length))} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** A question put to the agents on a call: when, and the tasks that took it. */
interface Asked {
  id: number
  question: string
  at: number
  keys: string[]
}
// What was asked on each call, kept while the window is open: the page is drawn again when the person moves between screens.
const askedOn = new Map<string, Asked[]>()
const NONE: string[] = []
let askedCount = 0
const MOST_ASKS = 3
// How often an answer is looked for while it is awaited, and how long after the question it is looked for at all.
const ANSWER_EVERY_MS = 2_500
const ANSWER_FOR_MS = 30 * 60_000

/**
 * What a task has said since a question was put to it: the last of its words after the question, and a line of what it did. Read
 * from the agent's own record of the conversation (else from what Togle saw of the task), and again while the task works.
 */
function useAnswer(key: string, asked: Asked, state: TaskView['state'] | undefined): { text: string; steps: string | undefined; seen: boolean } {
  const [found, setFound] = useState({ text: '', steps: undefined as string | undefined, seen: false })
  // The question is found in the conversation by its first words: the message that carried it held more.
  const mark = asked.question.replace(/\s+/g, ' ').slice(0, 60)
  const over = state !== 'working' && state !== 'waiting'
  const answered = found.text !== ''
  useEffect(() => {
    let live = true
    const read = async (): Promise<void> => {
      const history = await api.runnerHistory(key).catch(() => null)
      const entries = history?.entries ?? (await api.runnerDetail(key).catch(() => null))?.log ?? []
      if (!live) return
      let at = -1
      entries.forEach((entry, index) => { if (entry.kind === 'you' && entry.text.replace(/\s+/g, ' ').includes(mark)) at = index })
      if (at < 0) return
      const after = entries.slice(at + 1)
      const last = [...after].reverse().find((entry) => entry.kind === 'agent')
      setFound({ text: last?.text ?? '', steps: stepsLine(after), seen: true })
    }
    void read()
    // Looked for while the task works, and while nothing was found yet: not for ever.
    const timer = over && answered ? undefined : setInterval(() => { if (Date.now() - asked.at < ANSWER_FOR_MS) void read() }, ANSWER_EVERY_MS)
    return () => { live = false; if (timer) clearInterval(timer) }
  }, [key, mark, asked.at, over, answered])
  return found
}

const ANSWER_STATE: Record<TaskView['state'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Answered', stopped: 'Stopped', failed: 'Stopped by an error' }

/**
 * What an agent answered to a question asked on a call, under the question box: its words as it says them, and a card when it
 * needs your Allow to go on. Other notices still wait until the call ends.
 */
function CallAnswer({ taskKey, asked, task, onDismiss }: { taskKey: string; asked: Asked; task: TaskView | undefined; onDismiss: () => void }) {
  const said = useAnswer(taskKey, asked, task?.state)
  const [error, setError] = useState('')
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setError('')
    try { await work() } catch (failure) { setError(errorText(failure)) }
  }
  const state = task?.state
  // Idle, with nothing of its words to show: it said only steps, or its agent keeps no record Togle can read. Not said too early:
  // a task is idle a moment before the question reaches it.
  const finished = !!task && state !== 'working' && state !== 'waiting' && (said.seen || Date.now() - asked.at > 15_000)
  return (
    <section className="call-answer" aria-label={`${task ? agentOf(task) : 'The agent'} answers`}>
      <header className="call-answer-head">
        <b className="cut">{task ? <AgentLead runner={task.runner} name={agentOf(task)} rest={task.folder ? baseName(projectFolderOf(task.folder)) : task.title} /> : 'Gone'}</b>
        {state && <span className="state-chip" data-state={state}>{state === 'idle' && !said.text ? 'Idle' : ANSWER_STATE[state]}</span>}
        {task && <button type="button" className="link" onClick={() => openTaskFrom(taskKey)} title="Open the task in Agents">Open</button>}
        <button type="button" className="ghost small" aria-label="Dismiss this answer" onClick={onDismiss}><Icon name="close" size={12} /></button>
      </header>
      <p className="hint call-answer-question">You asked: {asked.question}</p>
      {said.text
        ? <div className="task-agent"><Markdown text={said.text} localFiles /></div>
        : <p className="hint">{!task ? 'That task is gone.' : finished ? 'It finished. Open it to read what it said.' : 'Working on it…'}</p>}
      {said.steps && <p className="hint">{said.steps}</p>}
      {task?.pending.map((request) => (
        <RequestCard key={request.id} request={request} onAllow={() => void act(() => api.answerRunnerTask(taskKey, request.id, 'allow-once'))} onAlways={() => void act(() => api.answerRunnerTask(taskKey, request.id, 'allow-always'))} onRefuse={() => void act(() => api.answerRunnerTask(taskKey, request.id, 'refuse'))} onReply={(text) => void act(() => api.replyRunnerTask(taskKey, request.id, text))} />
      ))}
      {task?.mine && task.waitingFor && !task.pending.length && <p className="hint">It waits on its screen: {task.waitingFor}. Open it to answer.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

// What was typed for a call's agents and not given yet, kept while the window is open: closing the list by a click elsewhere
// loses nothing.
const giveWords = new Map<string, string>()
// What was typed for a new task on a call that goes on (or is about to start), kept while the window is open, as the words for giving a call are.
const connectWords = new Map<string, string>()
// The room the list keeps: from its button, from the window's lower edge, and from the title bar when it has to move up.
const GIVE_GAP = 8, GIVE_EDGE = 12, GIVE_CEILING = 44

/**
 * The list that gives a call to agents: the existing tasks on this computer to tick (any number), and a new task, with what to do
 * with the call. In `connect` mode it only picks the agents on the call, for Send to find. It opens under its button and over
 * the page, as a menu does: Escape or a click elsewhere closes it, and in a low window it moves up and scrolls in itself, so
 * that its buttons are never under the window's edge.
 */
export function GivePanel({ call, mode, connected, onClose, onChanged, onGiven }: {
  call: string
  mode: 'give' | 'connect'
  connected: string[]
  onClose: () => void
  /** Connect mode: the list as it is after Add (`keepOpen`: the panel stays, for something that did not go through). */
  onChanged?: (agents: CallAgentList, keepOpen?: boolean) => void
  /** Give mode: what giving the call did. */
  onGiven?: (results: GiveResult[], line: string) => void
}) {
  const { tasks, loaded } = useTasks()
  const [status, setStatus] = useState<RunnerStatus[]>([])
  const [picked, setPicked] = useState<string[]>(connected)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [runner, setRunner] = useState<RunnerKind | undefined>()
  const [folder, setFolder] = useState('')
  const [words, setWords] = useState(() => (mode === 'give' ? giveWords : connectWords).get(call) ?? '')
  const remember = (value: string): void => { setWords(value); (mode === 'give' ? giveWords : connectWords).set(call, value) }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const panel = useRef<HTMLFormElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const working = useRef(busy)
  working.current = busy
  useEffect(() => {
    void api.runnerStatus().then((found) => setStatus(Array.isArray(found) ? found.filter((item) => item.installed) : []), () => undefined)
  }, [])
  // The keys go to the list as it opens, and back to the button that opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus({ preventScroll: true })
    return () => { if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      // Not a click in the list, in a menu the list opened, or on the button that opened the list (which closes it itself).
      if (!target || panel.current?.contains(target) || target.closest('.popover, [aria-expanded="true"]')) return
      if (!working.current) close.current()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || working.current) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key) }
  }, [])
  useEffect(() => { setRunner((current) => (current && status.some((item) => item.runner === current) ? current : status[0]?.runner)) }, [status])
  const pickedAgent = status.find((item) => item.runner === runner)
  const problemFor = mode === 'give' ? taskHandoffProblem : whyNotSent
  const searchable = mode === 'give' && tasks.length > MOST_ROWS
  const rows = useMemo(() => {
    const query = searchable ? search.trim().toLowerCase() : ''
    const candidates = tasks.filter(task => mode === 'connect'
      ? task.mine || Date.now() - task.updatedAt < RECENT_MS || connected.includes(task.key)
      : !query || [task.title, agentOf(task), task.folder].some(value => value.toLowerCase().includes(query)))
    candidates.sort((a, b) => Number(!!problemFor(a)) - Number(!!problemFor(b)) || b.updatedAt - a.updatedAt)
    return mode === 'connect' ? candidates.slice(0, MOST_ROWS) : candidates
  }, [tasks, mode, connected, search, searchable, problemFor])
  // The folders tasks work in, the one a task was most recently in first: that is the one a new task starts in.
  const folders = useMemo(() => [...new Set([...tasks].sort((a, b) => b.updatedAt - a.updatedAt).map((task) => task.folder).filter(Boolean))].slice(0, 6), [tasks])
  useEffect(() => { if (!folder && folders[0]) setFolder(folders[0]) }, [folder, folders])
  const toggle = (key: string): void => setPicked((previous) => (previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key]))
  // A task that is gone is not offered, and not given the call: it is left out of what is ticked.
  const present = loaded ? picked.filter(key => tasks.some(task => task.key === key && (mode === 'connect' || !taskHandoffProblem(task)))) : picked
  const count = present.length + (creating ? 1 : 0)
  const newReady = !creating || (!!runner && !!folder && !!words.trim())
  const ready = mode === 'connect' ? newReady : count > 0 && newReady
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (busy || !ready) return
    setBusy(true); setError('')
    try {
      if (mode === 'connect') {
        const kept = await api.setCallAgents(call, present)
        if (!creating || !runner) { onChanged?.(kept); return }
        // A new agent, started now with the person's words and connected to the call.
        const results = await api.giveCall({ call, tasks: [], prompt: words, connect: true, start: { runner, folder } })
        const failed = results.filter((result) => !result.ok)
        if (failed.length) {
          setError(resultLine(failed, tasks).text)
          onChanged?.(await api.callAgents(call), true)
          return
        }
        connectWords.delete(call)
        onChanged?.(await api.callAgents(call))
        return
      }
      const results = await api.giveCall({ call, tasks: present, prompt: words, connect: true, ...(creating && runner ? { start: { runner, folder } } : {}) })
      onGiven?.(results, resultLine(results, tasks).text)
      if (results.every((result) => result.ok)) { giveWords.delete(call); onClose() }
      else {
        const sent = results.filter(result => result.ok)
        setPicked(present.filter(key => !sent.some(result => result.key === key)))
        if (creating && sent.some(result => !present.includes(result.key))) setCreating(false)
        setError(resultLine(results, tasks).text)
      }
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  const choose = useCallback(async (): Promise<void> => {
    try { const chosen = await api.pickRunnerFolder(); if (chosen) setFolder(chosen) } catch (failure) { setError(errorText(failure)) }
  }, [])
  const options = folder && !folders.includes(folder) ? [folder, ...folders] : folders
  // Where it has room: under its button. Where the window is too low for that, it moves up (over its button, as far as the
  // title bar) and, when even that is too little, its rows scroll between its name and its buttons, which stay in view.
  const [fit, setFit] = useState<{ up: number; height?: number }>({ up: 0 })
  useLayoutEffect(() => {
    const measure = (): void => {
      const box = panel.current
      const anchor = box?.offsetParent
      if (!box || !anchor) return
      const under = anchor.getBoundingClientRect().bottom + GIVE_GAP
      const floor = window.innerHeight - GIVE_EDGE
      // As tall as it is with every row showing: the rows that scroll count whole.
      const list = box.querySelector('.give-rows')
      const natural = box.scrollHeight + (list ? list.scrollHeight - list.clientHeight : 0) + 2
      const over = under + natural - floor
      const up = over > 0 ? Math.max(0, Math.min(over, under - GIVE_CEILING)) : 0
      const height = over > up ? Math.max(120, floor - (under - up)) : undefined
      setFit((previous) => (previous.up === up && previous.height === height ? previous : { up, height }))
    }
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true) }
  }, [rows.length, creating, error, mode, status.length, searchable])
  const newTaskRow = (
    <label className="give-row">
      <input type="checkbox" checked={creating} disabled={!status.length} onChange={(event) => setCreating(event.target.checked)} />
      <span className="grow">
        <b>New task</b>
        <small>{creating ? '' : status.length ? (mode === 'give' ? 'Starts an agent with the call' : 'Starts an agent for this call') : 'No agent found'}</small>
        {creating && (
          <span className="give-new">
            <Menu className="pick-chip" ariaLabel="Agent" title="The agent that does it" label={pickedAgent ? <AgentMark runner={pickedAgent.runner} name={pickedAgent.name} /> : 'Pick an agent'}
              items={status.map((item) => ({ label: <AgentMark runner={item.runner} name={item.name} />, checked: item.runner === runner, onSelect: () => setRunner(item.runner) }))} />
            <Menu className="pick-chip" ariaLabel="Folder" title={folder || 'The folder it works in'} label={folder ? baseName(folder) : 'Pick a folder'}
              items={[...options.map((path) => ({ label: baseName(path), detail: path, checked: path === folder, onSelect: () => setFolder(path) })), ...(options.length ? ['divider' as const] : []), { label: 'Choose…', onSelect: () => void choose() }]} />
          </span>
        )}
      </span>
    </label>
  )
  return (
    <form ref={panel} tabIndex={-1} className="give-panel" aria-label={mode === 'give' ? 'Give this call to' : 'Add agents to this call'} onSubmit={(event) => void submit(event)}
      style={{ maxHeight: fit.height, transform: fit.up ? `translateY(${-fit.up}px)` : undefined }}>
      <strong>{mode === 'give' ? 'Give this call to' : 'Agents on this call'}</strong>
      {searchable && <input type="search" aria-label="Find an existing task" placeholder="Find a task, agent or project" value={search} onChange={event => setSearch(event.target.value)} />}
      <div className="give-rows" role="group">
        {searchable && newTaskRow}
        {rows.map((task) => {
          const reason = problemFor(task)
          return (
            <label key={task.key} className="give-row" aria-disabled={!!reason}>
              <input type="checkbox" checked={picked.includes(task.key)} disabled={!!reason && !picked.includes(task.key)} onChange={() => toggle(task.key)} />
              <span className="grow">
                <b className="cut">{task.title}</b>
                <small className="cut" title={task.folder}><AgentLead runner={task.runner} name={agentOf(task)} rest={reason || whereRest(task)} /></small>
              </span>
            </label>
          )
        })}
        {!rows.length && <p className="hint">{!loaded ? 'Looking for tasks…' : tasks.length && searchable ? 'No matching tasks.' : mode === 'give' ? 'No existing tasks yet. You can start a new task below.' : 'No agent task on this computer yet. Start one from Agents, and it shows here.'}</p>}
        {!searchable && newTaskRow}
      </div>
      {/* The words and the button that gives the call share one box, as the design draws it. */}
      {mode === 'give' && (
        <div className="field give-field">
          <input className="give-words" aria-label="What should they do with it?" placeholder="What should they do with it?" value={words} maxLength={4000} onChange={(event) => remember(event.target.value)} />
          <button className="primary small" disabled={busy || !ready}>{busy ? 'Giving…' : count ? `Give to ${count}` : 'Give'}</button>
        </div>
      )}
      {mode === 'connect' && creating && (
        <div className="field give-field">
          <input className="give-words" aria-label="What should it do?" placeholder="What should it do?" value={words} maxLength={4000} autoFocus onChange={(event) => remember(event.target.value)} />
        </div>
      )}
      {mode === 'connect' && creating && <p className="hint">It starts with your words, and with the call as it stands if anything was said. A new Claude Code or Codex task asks before it runs anything. It stays on this call: Send and Ask reach it.</p>}
      {mode === 'give' && <p className="hint">A new Claude Code or Codex task asks before it runs anything. Hermes and an agent already running keep their own settings, so each one is told to read the call as information and not as instructions.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        {mode === 'connect' && <button className="primary small" disabled={busy || !ready}>{busy ? (creating ? 'Starting…' : 'Adding…') : creating ? 'Start and add' : 'Done'}</button>}
        <button type="button" className={mode === 'give' ? 'quiet-action' : 'ghost small'} onClick={onClose}>Cancel</button>
      </div>
    </form>
  )
}
