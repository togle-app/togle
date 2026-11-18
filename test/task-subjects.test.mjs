// Togle's sorting of the Agents list by subject (subjects.ts): what goes to the AI, how its answer is held to Togle's rules,
// and that nothing is asked twice. The AI here is a stand-in that answers as each test tells it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const T = await import(pathToFileURL(path.join(here, '.build/togle.mjs')).href)
// Where what is kept between runs goes, in this test.
const directory = path.join(here, '.work', `task-subjects-${process.pid}`)
rmSync(directory, { recursive: true, force: true })
mkdirSync(directory, { recursive: true })
process.env.TOGLE_TEST_USER_DATA = directory

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check, what, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`waited for ${what}`)
    await pause(5)
  }
}

const SITE = 'project:c:\\work\\website'
const task = (key, name, place = SITE, where = 'project website') => ({ key, name, place, where })
/** Every task the AI is asked about gets `heading(task)`, or keeps the heading it came with. */
const answering = (heading) => (input) => ({ subjects: Object.fromEntries(input.tasks.map((t) => [t.id, t.now ?? heading(t)])) })

/** Sorting with a stand-in AI: each question is kept, and `answer` makes the reply (an Error fails it). */
function sorting(answer, { settleMs = 0, retryMs = 60_000, timeoutMs = 60_000, file = null, on = true } = {}) {
  const asked = []
  const renamed = []
  let changes = 0
  let isOn = on
  const subjects = new T.TaskSubjects({
    on: () => isOn,
    ask: () => async (system, user) => {
      const input = JSON.parse(user)
      asked.push({ system, input })
      const out = await answer(input, asked.length)
      if (out instanceof Error) throw out
      return typeof out === 'string' ? out : JSON.stringify(out)
    },
    changed: () => changes++,
    renamed: (place, from, to) => renamed.push([place, from, to]),
    file,
    settleMs,
    retryMs,
    timeoutMs,
    warn: () => undefined
  })
  return { subjects, asked, renamed, changes: () => changes, turn: (value) => { isOn = value } }
}

test('a place is sorted from its second task, and the AI reads only the names of the tasks and of the place', async () => {
  const s = sorting(answering(() => 'Login'))
  s.subjects.notice([task('claude:a', 'Fix login redirect')])
  await pause(30)
  assert.equal(s.asked.length, 0, 'one task: nothing to sort')
  s.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  await until(() => s.subjects.of('codex:b', SITE), 'the headings')
  assert.equal(s.asked.length, 1)
  assert.equal(s.asked[0].system, T.SORT_PROMPT)
  assert.deepEqual(s.asked[0].input, { place: 'project website', tasks: [{ id: 't1', name: 'Fix login redirect' }, { id: 't2', name: 'Login with magic link' }] })
  assert.equal(s.subjects.of('claude:a', SITE), 'Login')
  assert.equal(s.subjects.of('claude:a', 'everyday'), undefined, 'a heading is for the place it was given in')
  assert.equal(s.changes(), 1, 'the window is told once')
})

test('the same list again sends nothing; a task joining sends the place again, each task with its heading', async () => {
  const s = sorting(answering((t) => (t.name.includes('blog') ? 'Blog' : 'Login')))
  const two = [task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')]
  s.subjects.notice(two)
  await until(() => s.subjects.of('claude:a', SITE), 'the first sort')
  for (let i = 0; i < 5; i++) s.subjects.notice(two)
  await pause(30)
  assert.equal(s.asked.length, 1, 'listed again (the window asks after each change): no question')
  // A backend whose list dropped out and came back brings no new task.
  s.subjects.notice([two[0]])
  s.subjects.notice(two)
  await pause(30)
  assert.equal(s.asked.length, 1, 'tasks that come back are not new')
  s.subjects.notice([...two, task('claude:c', 'Add RSS feed to blog')])
  await until(() => s.subjects.of('claude:c', SITE), 'the new task sorted')
  assert.equal(s.asked.length, 2)
  assert.deepEqual(s.asked[1].input.tasks, [{ id: 't1', name: 'Fix login redirect', now: 'Login' }, { id: 't2', name: 'Login with magic link', now: 'Login' }, { id: 't3', name: 'Add RSS feed to blog' }])
  assert.equal(s.subjects.of('claude:c', SITE), 'Blog')
})

test('the answer is held to Togle\'s rules: a heading never splits, a sorted task keeps one, a case is the place\'s', () => {
  // The AI split Login: the heading most of its tasks got holds them all, and the rename is told.
  assert.deepEqual(T.settleSubjects(['Login', 'Login', 'Login', null], ['Auth', 'Auth', 'Login', 'Blog']), { subjects: ['Auth', 'Auth', 'Auth', 'Blog'], renamed: [['Login', 'Auth']] })
  // A tie keeps the heading the tasks had.
  assert.deepEqual(T.settleSubjects(['Login', 'Login'], ['Auth', 'Login']), { subjects: ['Login', 'Login'], renamed: [] })
  // Two headings joined into a broader one: both are told.
  assert.deepEqual(T.settleSubjects(['Signup', 'Password', null], ['Authentication', 'Authentication', 'Authentication']), { subjects: ['Authentication', 'Authentication', 'Authentication'], renamed: [['Signup', 'Authentication'], ['Password', 'Authentication']] })
  // A sorted task the answer gave none keeps its own; a new one given none waits apart.
  assert.deepEqual(T.settleSubjects(['Blog', null], [null, null]).subjects, ['Blog', null])
  // A heading written in another case is the one the place has.
  assert.deepEqual(T.settleSubjects(['Blog', null], ['blog', 'BLOG']).subjects, ['Blog', 'Blog'])
})

test('a heading renamed in a sort is told, so the tasks the person dropped on it follow it', async () => {
  const s = sorting((input, n) => (n === 1 ? answering(() => 'Signup')(input) : { subjects: Object.fromEntries(input.tasks.map((t) => [t.id, 'Authentication'])) }))
  const two = [task('claude:a', 'Signup bug'), task('codex:b', 'Signup email')]
  s.subjects.notice(two)
  await until(() => s.subjects.of('claude:a', SITE) === 'Signup', 'the first headings')
  s.subjects.notice([...two, task('claude:c', 'Password reset')])
  await until(() => s.subjects.of('claude:c', SITE) === 'Authentication', 'the broader heading')
  assert.deepEqual(s.renamed, [[SITE, 'Signup', 'Authentication']])
  assert.equal(s.subjects.of('claude:a', SITE), 'Authentication')
})

test('a heading renamed while one of its tasks is not listed takes that task along: it comes back with the others', async () => {
  const s = sorting((input, n) => (n === 1 ? answering(() => 'Signup')(input) : { subjects: Object.fromEntries(input.tasks.map((t) => [t.id, 'Authentication'])) }))
  const three = [task('claude:a', 'Signup bug'), task('hermes:b', 'Signup email'), task('claude:c', 'Signup page copy')]
  s.subjects.notice(three)
  await until(() => s.subjects.of('hermes:b', SITE) === 'Signup', 'the first headings')
  // Hermes's list is missing for a moment while a task joins.
  s.subjects.notice([three[0], three[2], task('claude:d', 'Password reset')])
  await until(() => s.subjects.of('claude:d', SITE) === 'Authentication', 'the broader heading')
  assert.equal(s.asked[1].input.tasks.length, 3, 'only the tasks listed are sent')
  assert.equal(s.subjects.of('hermes:b', SITE), 'Authentication', 'the one not listed is under the new name too')
})

test('a failed sort waits before it is tried again; a task the answer left out is not asked about again until renamed', async () => {
  let fail = true
  const s = sorting(() => (fail ? new Error('offline') : { subjects: { t1: 'Login' } }), { retryMs: 80 })
  const two = [task('claude:a', 'Fix login redirect'), task('codex:b', 'Quick question')]
  s.subjects.notice(two)
  await until(() => s.asked.length === 1, 'the first try')
  for (let i = 0; i < 5; i++) s.subjects.notice(two)
  await pause(20)
  assert.equal(s.asked.length, 1, 'not again at once')
  fail = false
  await until(() => s.subjects.of('claude:a', SITE) === 'Login', 'tried again after the wait')
  assert.equal(s.asked.length, 2)
  assert.equal(s.subjects.of('codex:b', SITE), undefined, 'left out: no heading')
  for (let i = 0; i < 5; i++) s.subjects.notice(two)
  await pause(150)
  assert.equal(s.asked.length, 2, 'decided: not asked again')
  s.subjects.notice([two[0], task('codex:b', 'Rename the login button')])
  await until(() => s.asked.length === 3, 'renamed, it is sorted again')
})

test('an answer that never comes is given up at its time, and sorting goes on', async () => {
  // The first question hangs, whatever the signal says; the next is answered.
  const s = sorting((input, n) => (n === 1 ? new Promise(() => undefined) : answering(() => 'Login')(input)), { timeoutMs: 40, retryMs: 30 })
  s.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  await until(() => s.subjects.of('claude:a', SITE) === 'Login', 'sorted after the one that hung')
  assert.equal(s.asked.length, 2)
})

test('a place that keeps failing waits twice as long each time', async () => {
  const s = sorting(() => new Error('offline'), { retryMs: 50 })
  s.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  // Tried at about 0, 50, 150 and 350 ms: four times in 420 ms, where the same wait each time would be nine.
  await pause(420)
  assert.ok(s.asked.length >= 3 && s.asked.length <= 5, `asked ${s.asked.length} times`)
})

test('a place too big for one question is sorted in turns, each task asked about once', async () => {
  const s = sorting(answering((t) => (Number(t.name.split(' ')[1]) % 2 ? 'Odd' : 'Even')))
  const many = Array.from({ length: 170 }, (_, i) => task(`claude:${i}`, `Task ${i}`))
  s.subjects.notice(many)
  await until(() => many.every((t) => s.subjects.of(t.key, SITE)), 'every task sorted')
  assert.deepEqual(s.asked.map((q) => q.input.tasks.length), [80, 80, 80], 'at most 80 in one question')
  assert.deepEqual(s.asked.map((q) => q.input.tasks.filter((t) => !t.now).length), [80, 80, 10], 'the ones waiting first, the last with the latest sorted around them')
})

test('an answer that is not the JSON asked for changes nothing and waits like a failure', async () => {
  const s = sorting(() => 'Sure! Here are the subjects.', { retryMs: 60_000 })
  s.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  await until(() => s.asked.length === 1, 'the try')
  await pause(30)
  assert.equal(s.subjects.of('claude:a', SITE), undefined)
  assert.equal(s.changes(), 0)
  s.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  await pause(30)
  assert.equal(s.asked.length, 1, 'not again before the wait')
})

test('a task is sorted once its name has held: a name its agent changes at first is not sent', async () => {
  const s = sorting(answering(() => 'Login'), { settleMs: 80 })
  const a = task('claude:a', 'Fix login redirect')
  s.subjects.notice([a, task('claude:b', 'Fix the')])
  await pause(40)
  s.subjects.notice([a, task('claude:b', 'Fix the login button')])
  await until(() => s.asked.length === 1, 'one sort')
  await pause(120)
  assert.equal(s.asked.length, 1)
  assert.equal(s.asked[0].input.tasks[1].name, 'Fix the login button')
})

test('turned off, nothing is sent and no heading shows; turned on, the kept headings show and what came meanwhile is sorted', async () => {
  const s = sorting(answering(() => 'Login'))
  const two = [task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')]
  s.subjects.notice(two)
  await until(() => s.subjects.of('claude:a', SITE) === 'Login', 'sorted')
  s.turn(false)
  s.subjects.turned()
  assert.equal(s.subjects.of('claude:a', SITE), undefined)
  s.subjects.notice([...two, task('claude:c', 'Login button color')])
  await pause(30)
  assert.equal(s.asked.length, 1, 'off: nothing sent')
  s.turn(true)
  s.subjects.turned()
  assert.equal(s.subjects.of('claude:a', SITE), 'Login', 'kept while it was off')
  await until(() => s.asked.length === 2, 'the task that came while it was off')
})

test('places are sorted one at a time, each with its own tasks', async () => {
  let open = 0
  let most = 0
  const s = sorting(async (input) => {
    open++
    most = Math.max(most, open)
    await pause(20)
    open--
    return answering(() => (input.place.startsWith('Everyday') ? 'Email' : 'Login'))(input)
  })
  s.subjects.notice([
    task('claude:a', 'Fix login redirect'),
    task('codex:b', 'Login with magic link'),
    task('hermes:c', 'Summarize my email', 'everyday', T.placeWords('everyday', '')),
    task('hermes:d', 'Clean up my inbox', 'everyday', T.placeWords('everyday', ''))
  ])
  await until(() => s.subjects.of('hermes:d', 'everyday') && s.subjects.of('codex:b', SITE), 'both places')
  assert.equal(most, 1, 'one question at a time')
  assert.deepEqual(s.asked.map((q) => [q.input.place, q.input.tasks.length]), [['project website', 2], ['Everyday (work outside any project)', 2]])
})

test('what the AI is told of a place: its folder\'s name, or Everyday', () => {
  assert.equal(T.placeWords('project:c:\\work\\acme-website', 'C:\\work\\acme-website\\'), 'project acme-website')
  assert.equal(T.placeWords('project:/home/sam/notes', '/home/sam/notes'), 'project notes')
  assert.equal(T.placeWords('everyday', ''), 'Everyday (work outside any project)')
})

test('what was sorted is kept between runs', async () => {
  const file = 'runner-subjects.json'
  const s = sorting(answering(() => 'Login'), { file })
  s.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  await until(() => s.subjects.of('claude:a', SITE) === 'Login', 'sorted')
  await pause(700)
  const again = sorting(() => new Error('not asked'), { file })
  await again.subjects.load()
  assert.equal(again.subjects.of('codex:b', SITE), 'Login')
  again.subjects.notice([task('claude:a', 'Fix login redirect'), task('codex:b', 'Login with magic link')])
  await pause(30)
  assert.equal(again.asked.length, 0, 'kept: nothing to ask')
  rmSync(directory, { recursive: true, force: true })
})
