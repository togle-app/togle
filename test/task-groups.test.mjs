// The person's own arrangement of the Agents list (task-groups.ts): groups they make, names they give, tasks they move,
// headings they fold, and main's store of it (titles.ts). Only what fits is kept.
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
  assert.deepEqual(T.cleanGroups({
    made: [{ id: 'OK!', name: 'x' }, { id: 'g2abc', name: '' }, { id: 'g3abc', name: 'Team' }],
    names: { everyday: 'Home', bad: 5 },
    placed: { a: { group: 'scheduled' }, b: { group: 'made:g3abc', subject: 'Plans' }, c: { group: '' } },
    folded: [{ group: 'everyday', subject: ' Email ' }, { group: 'everyday', subject: 'EMAIL' }, { group: 'scheduled', subject: 'Jobs' }, { group: 'everyday', subject: '' }, 'odd', null]
  }), {
    made: [{ id: 'g3abc', name: 'Team' }],
    names: { everyday: 'Home' },
    placed: { b: { group: 'made:g3abc', subject: 'Plans' } },
    folded: [{ group: 'everyday', subject: 'Email' }],
    earlierFolded: [{ group: 'everyday', subject: 'Email' }]
  })
  assert.deepEqual(T.cleanGroups('not this'), T.NO_GROUPS)
  assert.deepEqual(T.cleanGroups({ made: [], names: {}, placed: {} }).folded, [], 'kept before headings folded: none is')
})

test('Earlier and recent subject headings can be opened independently after upgrading and renaming', () => {
  const group = 'everyday', subject = 'Code review'
  let groups = T.cleanGroups({ folded: [{ group, subject }] })
  const open = { kind: 'fold-subject', group, subject, folded: false }
  groups = T.applyGroupChange(groups, { ...open, earlier: true })
  assert.equal(T.subjectFolded(groups, group, subject), true)
  assert.equal(T.subjectFolded(groups, group, subject, true), false)
  groups = T.applyGroupChange(groups, open)
  groups = T.applyGroupChange(groups, { ...open, earlier: true, folded: true })
  groups = T.applyGroupChange(groups, { kind: 'rename-subject', group, from: subject, to: 'Review' })
  const saved = T.cleanGroups(JSON.parse(JSON.stringify(groups)))
  assert.equal(T.subjectFolded(saved, group, 'Review'), false)
  assert.equal(T.subjectFolded(saved, group, 'Review', true), true)
  assert.equal(T.subjectFolded(saved, group, subject, true), false)
})

test('a subject heading folded stays folded, under its new name too, and goes with the group it is in', () => {
  const website = 'project:c:\\work\\website'
  let groups = T.applyGroupChange(T.NO_GROUPS, { kind: 'fold-subject', group: website, subject: 'Signup', folded: true })
  assert.deepEqual(groups.folded, [{ group: website, subject: 'Signup' }])
  assert.equal(T.subjectFolded(groups, website, 'SIGNUP'), true, 'the same heading in another case')
  assert.equal(T.subjectFolded(groups, 'everyday', 'Signup'), false, 'a heading of that name in another group is not')
  assert.equal(T.applyGroupChange(groups, { kind: 'fold-subject', group: website, subject: 'signup', folded: true }), groups, 'folded already: nothing changes')
  assert.equal(T.applyGroupChange(groups, { kind: 'fold-subject', group: website, subject: 'Blog', folded: 'yes' }), groups, 'only a yes or a no')
  assert.equal(T.applyGroupChange(groups, { kind: 'fold-subject', group: 'scheduled', subject: 'Jobs', folded: true }), groups, 'Scheduled has no headings')
  // Togle's sorting gives it another name: folded still. A heading it is not, nor one in another group, is left as it is.
  groups = T.applyGroupChange(groups, { kind: 'fold-subject', group: 'everyday', subject: 'Signup', folded: true })
  groups = T.applyGroupChange(groups, { kind: 'rename-subject', group: website, from: 'signup', to: 'Authentication' })
  assert.deepEqual(groups.folded, [{ group: 'everyday', subject: 'Signup' }, { group: website, subject: 'Authentication' }])
  const open = T.applyGroupChange(T.NO_GROUPS, { kind: 'place', task: 'codex:t1', group: website, subject: 'Blog' })
  assert.deepEqual(T.applyGroupChange(open, { kind: 'rename-subject', group: website, from: 'Blog', to: 'Writing' }).folded, [], 'one not folded stays open')
  // Joined to a heading that was folded too: one fold, under the name it joined.
  groups = T.applyGroupChange(groups, { kind: 'fold-subject', group: website, subject: 'Login', folded: true })
  groups = T.applyGroupChange(groups, { kind: 'rename-subject', group: website, from: 'Login', to: 'authentication' })
  assert.deepEqual(groups.folded.filter((at) => at.group === website), [{ group: website, subject: 'authentication' }])
  // Opened again.
  groups = T.applyGroupChange(groups, { kind: 'fold-subject', group: website, subject: 'Authentication', folded: false })
  assert.deepEqual(groups.folded, [{ group: 'everyday', subject: 'Signup' }])
  // A made group deleted: its headings' folds go with it.
  groups = T.applyGroupChange(groups, { kind: 'make', id: 'g1abc', name: 'Launch' })
  groups = T.applyGroupChange(groups, { kind: 'fold-subject', group: 'made:g1abc', subject: 'Plans', folded: true })
  groups = T.applyGroupChange(groups, { kind: 'remove', group: 'made:g1abc' })
  assert.deepEqual(groups.folded, [{ group: 'everyday', subject: 'Signup' }])
})

test('main keeps a folded heading between runs', async () => {
  const fs = await import('node:fs/promises')
  // Where what is kept goes, in this test (the stand-in for Electron reads it).
  const folder = path.join(here, '.work', 'task-groups-' + process.pid)
  await fs.rm(folder, { recursive: true, force: true })
  await fs.mkdir(folder, { recursive: true })
  process.env.TOGLE_TEST_USER_DATA = folder
  try {
    const first = new T.StoredGroups('runner-groups.json')
    await first.load()
    first.change({ kind: 'fold-subject', group: 'everyday', subject: 'Email', folded: true })
    const kept = () => fs.readFile(path.join(folder, 'runner-groups.json'), 'utf8').catch(() => '')
    for (let n = 0; n < 150 && !(await kept()).includes('Email'); n++) await new Promise((resolve) => setTimeout(resolve, 20))
    const second = new T.StoredGroups('runner-groups.json')
    await second.load()
    assert.deepEqual(second.get().folded, [{ group: 'everyday', subject: 'Email' }])
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
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

test('a copy of a project that Claude Code makes for a session is in the project it was copied from', () => {
  const copy = 'C:\\work\\shop\\.claude\\worktrees\\design-cleanup'
  assert.equal(T.projectFolderOf(copy), 'C:\\work\\shop')
  assert.equal(T.projectFolderOf(copy + '\\web\\togle.app'), 'C:\\work\\shop', 'a folder inside the copy as well')
  assert.equal(T.projectFolderOf(copy + '\\'), 'C:\\work\\shop', 'with a slash at the end')
  assert.equal(T.projectFolderOf('/home/sam/togle/.claude/worktrees/fix-login/src'), '/home/sam/togle', 'with the slashes of another system')
  assert.equal(T.projectFolderOf('C:\\work\\worktrees\\x'), 'C:\\work\\worktrees\\x', 'a folder that only looks like one is its own project')
  assert.equal(T.projectFolderOf('C:\\work\\shop\\.claude\\worktrees'), 'C:\\work\\shop\\.claude\\worktrees', 'the folder that holds the copies is no copy')
  assert.equal(T.projectFolderOf('C:\\work\\shop'), 'C:\\work\\shop')
  assert.equal(T.projectFolderOf(''), '')
  // One box in the list, whichever of the two folders the session is in, and however the path is written on Windows.
  assert.equal(T.ownGroupOf({ folder: copy }, 'win32'), 'project:c:\\work\\shop')
  assert.equal(T.ownGroupOf({ folder: copy + '\\web' }, 'win32'), T.ownGroupOf({ folder: 'c:\\work\\Shop\\' }, 'win32'))
})
