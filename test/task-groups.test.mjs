// The person's own arrangement of the Agents list (task-groups.ts): groups they make, names they give, tasks they move, and
// main's store of it (titles.ts). Only what fits is kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const T = await import(pathToFileURL(path.join(here, '.build/togle.mjs')).href)

test('a group is made, renamed and deleted; the tasks in it go back when it goes', () => {
  let groups = T.NO_GROUPS
  groups = T.applyGroupChange(groups, { kind: 'make', id: 'g1abc', name: '  Launch   week ' })
  assert.deepEqual(groups.made, [{ id: 'g1abc', name: 'Launch week' }], 'its name, with its spaces tidied')
  groups = T.applyGroupChange(groups, { kind: 'place', task: 'claude:s3', group: 'made:g1abc' })
  groups = T.applyGroupChange(groups, { kind: 'rename', group: 'made:g1abc', name: 'Launch' })
  assert.equal(groups.made[0].name, 'Launch')
  assert.equal(T.applyGroupChange(groups, { kind: 'rename', group: 'made:g1abc', name: '  ' }), groups, 'a made group keeps a name')
  groups = T.applyGroupChange(groups, { kind: 'remove', group: 'made:g1abc' })
  assert.deepEqual([groups.made, groups.placed], [[], {}], 'gone, and its task back where Togle puts it')
})

test('a task moved stays with the subject it was dropped on; put back, it is Togle\'s again; nothing goes into Scheduled', () => {
  let groups = T.applyGroupChange(T.NO_GROUPS, { kind: 'place', task: 'codex:t1', group: 'project:c:\\work\\website', subject: 'Orders' })
  assert.deepEqual(groups.placed['codex:t1'], { group: 'project:c:\\work\\website', subject: 'Orders' })
  groups = T.applyGroupChange(groups, { kind: 'place', task: 'codex:t1', group: 'everyday' })
  assert.deepEqual(groups.placed['codex:t1'], { group: 'everyday' }, 'moved again, the last place counts')
  assert.equal(T.applyGroupChange(groups, { kind: 'place', task: 'codex:t1', group: 'scheduled' }), groups, 'only scheduled jobs are in Scheduled')
  assert.equal(T.applyGroupChange(groups, { kind: 'place', task: 'codex:t1', group: 'made:nothere' }), groups, 'not into a group that is not there')
  groups = T.applyGroupChange(groups, { kind: 'put-back', task: 'codex:t1' })
  assert.deepEqual(groups.placed, {})
})

test('a group of Togle\'s keeps the name the person gave it, and an empty name gives its own back', () => {
  let groups = T.applyGroupChange(T.NO_GROUPS, { kind: 'rename', group: 'project:c:\\work\\website', name: 'Website' })
  assert.deepEqual(groups.names, { 'project:c:\\work\\website': 'Website' })
  groups = T.applyGroupChange(groups, { kind: 'rename', group: 'project:c:\\work\\website', name: '' })
  assert.deepEqual(groups.names, {})
})

test('what was kept or sent is cleaned: odd ids, empty names, a place in Scheduled are left out', () => {
  assert.deepEqual(T.cleanGroups({ made: [{ id: 'OK!', name: 'x' }, { id: 'g2abc', name: '' }, { id: 'g3abc', name: 'Team' }], names: { everyday: 'Home', bad: 5 }, placed: { a: { group: 'scheduled' }, b: { group: 'made:g3abc', subject: 'Plans' }, c: { group: '' } } }), {
    made: [{ id: 'g3abc', name: 'Team' }],
    names: { everyday: 'Home' },
    placed: { b: { group: 'made:g3abc', subject: 'Plans' } }
  })
  assert.deepEqual(T.cleanGroups('not this'), T.NO_GROUPS)
})

test('main keeps the arrangement and gives it back as it is after each change', () => {
  const store = new T.StoredGroups(null)
  assert.deepEqual(store.get(), T.NO_GROUPS)
  const made = store.change({ kind: 'make', id: 'g9xyz', name: 'Errands' })
  assert.deepEqual(made.made, [{ id: 'g9xyz', name: 'Errands' }])
  assert.equal(store.change({ kind: 'make', id: 'g9xyz', name: 'Again' }), made, 'one id once')
  assert.deepEqual(store.change({ kind: 'place', task: 'hermes:c1', group: 'made:g9xyz' }).placed, { 'hermes:c1': { group: 'made:g9xyz' } })
})

test('a subject renamed by Togle\'s sorting takes along the tasks dropped on it in that group, and only those', () => {
  let groups = T.applyGroupChange(T.NO_GROUPS, { kind: 'place', task: 'codex:t1', group: 'project:c:\\work\\website', subject: 'Signup' })
  groups = T.applyGroupChange(groups, { kind: 'place', task: 'codex:t2', group: 'everyday', subject: 'Signup' })
  groups = T.applyGroupChange(groups, { kind: 'place', task: 'codex:t3', group: 'project:c:\\work\\website', subject: 'Blog' })
  const after = T.applyGroupChange(groups, { kind: 'rename-subject', group: 'project:c:\\work\\website', from: 'signup', to: 'Authentication' })
  assert.deepEqual(after.placed, {
    'codex:t1': { group: 'project:c:\\work\\website', subject: 'Authentication' },
    'codex:t2': { group: 'everyday', subject: 'Signup' },
    'codex:t3': { group: 'project:c:\\work\\website', subject: 'Blog' }
  })
  assert.equal(T.applyGroupChange(groups, { kind: 'rename-subject', group: 'project:c:\\work\\website', from: 'Orders', to: 'Shop' }), groups, 'nobody dropped a task on it: nothing changes')
})

test('the group Togle puts a task in, the same in the window and in main', () => {
  assert.equal(T.ownGroupOf({ folder: 'C:\\Work\\Website\\' }, 'win32'), 'project:c:\\work\\website')
  assert.equal(T.ownGroupOf({ folder: '/work/Website/' }, 'linux'), 'project:/work/Website', 'case counts where the system tells it apart')
  assert.equal(T.ownGroupOf({ folder: '', outsideProject: true }, 'win32'), 'everyday')
  assert.equal(T.ownGroupOf({ folder: 'C:\\Users\\sam', outsideProject: true }, 'win32'), 'everyday')
  assert.equal(T.ownGroupOf({ folder: 'C:\\work', schedule: 'every day at 8:00' }, 'win32'), 'scheduled')
  assert.equal(T.projectKeyOf('C:\\Work\\', 'win32'), 'c:\\work')
})
