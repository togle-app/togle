// What Claude Code keeps of a live session's work in its own folder (looked at on 2.1.328): a session whose turn ended while a command it
// started still runs is `shell` in its program's record, though `claude agents --json` calls it busy, and its job's state file lists the
// commands. Togle used to show that task as working.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const { claudeConfigDir, isJob, monitorsOf, shellsOf, stateOfJob, withShells } = await import('./.build/togle.mjs')

const made = []
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
/** A folder as Claude Code keeps its own: the program's records by pid, and each job's state file. */
const home = ({ registry = {}, jobs = {} } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-claude-registry-'))
  made.push(dir)
  mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  for (const [pid, record] of Object.entries(registry)) writeFileSync(path.join(dir, 'sessions', `${pid}.json`), typeof record === 'string' ? record : JSON.stringify(record))
  for (const [id, state] of Object.entries(jobs)) {
    mkdirSync(path.join(dir, 'jobs', id), { recursive: true })
    writeFileSync(path.join(dir, 'jobs', id, 'state.json'), JSON.stringify(state))
  }
  return dir
}
const shell = (id, label, extra = {}) => ({ id, kind: 'shell', label, startedAt: 1_795_060_000_000, ...extra })
const job = (row = {}) => ({ id: 'a1b2c3d4', kind: 'background', sessionId: 's-1', pid: 111, status: 'busy', ...row })

test('the shells a job runs are the unfinished shell items of its state file, one line each', () => {
  assert.deepEqual(shellsOf(null), [])
  assert.deepEqual(shellsOf({}), [])
  const fan = [
    { id: 'todo:1', kind: 'todo', label: 'Write it' },
    shell('b4h0lzltu', 'cd /repo &&\n  ./node_modules/.bin/electron   preview.cjs'),
    shell('bdone0001', 'npm test', { doneAt: 1_795_060_100_000 }),
    shell('bzero0001', 'npm test', { doneAt: 0 }),
    { kind: 'shell', label: 'no id' },
    shell('blong0001', 'x'.repeat(500)),
    shell('bsecret01', 'API_KEY=abcd1234efgh5678ijkl npm run dev')
  ]
  const found = shellsOf({ fan })
  assert.deepEqual(found.map((item) => item.id), ['b4h0lzltu', 'no id', 'blong0001', 'bsecret01'], 'a finished one (a doneAt, even 0) and a todo are not running shells')
  assert.equal(found[3].label.includes('abcd1234efgh5678ijkl'), false, 'a key in the command is not shown')
  assert.ok(found[3].label.endsWith('npm run dev'))
  assert.equal(found[0].label, 'cd /repo && ./node_modules/.bin/electron preview.cjs', 'in one line')
  assert.equal(found[0].since, 1_795_060_000_000)
  assert.equal(found[1].since, undefined, 'a shell with no time has none')
  assert.equal(found[2].label.length, 300, 'and a long command is cut')
})

test('busy by the list and shell by the program\'s record is idle with its shells; busy by both stays busy, shells shown', async () => {
  const dir = home({
    registry: { 111: { status: 'shell' }, 222: { status: 'busy' }, 333: { status: 'idle' } },
    jobs: { a1b2c3d4: { tempo: 'idle', fan: [shell('b1', 'npm run dev')] }, e5f6a7b8: { tempo: 'active', fan: [shell('b2', 'sleep 600')] }, c9d0e1f2: { tempo: 'idle', fan: [] } }
  })
  const rows = await withShells(dir, [
    job(),
    job({ id: 'e5f6a7b8', pid: 222, sessionId: 's-2' }),
    job({ id: 'c9d0e1f2', pid: 333, sessionId: 's-3', status: 'idle' }),
    // A program in a terminal of its own: no job, but the record says shell.
    { kind: 'interactive', sessionId: 's-4', pid: 111, status: 'busy' },
    // No program: nothing to read.
    { id: 'f3a4b5c6', kind: 'background', sessionId: 's-5', state: 'stopped' }
  ])
  assert.deepEqual([rows[0].status, rows[0].shells?.map((item) => item.label)], ['shell', ['npm run dev']], 'idle with a shell')
  assert.equal(stateOfJob(rows[0]), 'idle', 'which is Done, not working')
  assert.deepEqual([rows[1].status, rows[1].shells?.map((item) => item.label)], ['busy', ['sleep 600']], 'busy by its own record: working, and what runs shown')
  assert.equal(stateOfJob(rows[1]), 'working')
  assert.deepEqual([rows[2].status, rows[2].shells], ['idle', undefined], 'idle with nothing running is as it was')
  assert.deepEqual([rows[3].status, rows[3].shells], ['shell', undefined], 'a program in a terminal: idle, and its shells are not told (no job to read)')
  assert.deepEqual(rows[4], { id: 'f3a4b5c6', kind: 'background', sessionId: 's-5', state: 'stopped' }, 'a stopped session has no program to read')
  assert.equal(isJob(rows[0]), true)
})

test('without the program\'s record, the job\'s tempo decides; files that cannot be read leave the row as it was', async () => {
  const dir = home({
    registry: { 444: '{ not json' },
    jobs: { a1b2c3d4: { tempo: 'idle', fan: [shell('b1', 'npm run dev')] }, e5f6a7b8: { tempo: 'active', fan: [shell('b2', 'npm run dev')] } }
  })
  const [quiet, active, broken, nothing] = await withShells(dir, [
    job({ pid: 900 }),
    job({ id: 'e5f6a7b8', pid: 901, sessionId: 's-2' }),
    job({ id: '11223344', pid: 444, sessionId: 's-3' }),
    job({ id: '55667788', pid: 902, sessionId: 's-4' })
  ])
  assert.equal(quiet.status, 'shell', 'its tempo is idle and a shell runs: the turn is over')
  assert.equal(active.status, 'busy', 'its tempo is active: it works')
  assert.deepEqual(broken, job({ id: '11223344', pid: 444, sessionId: 's-3' }), 'a record that is not JSON, and no state file: as it was')
  assert.deepEqual(nothing, job({ id: '55667788', pid: 902, sessionId: 's-4' }), 'no files at all: as it was')
  assert.deepEqual(await withShells(path.join(dir, 'nowhere'), [job()]), [job()], 'no such folder: as it was')
})

const monitor = (id, label, extra = {}) => ({ id, kind: 'monitor', label, startedAt: 1_795_060_000_000, ...extra })

test('the monitors a job runs are the unfinished monitor items of its state file, apart from its shells', () => {
  assert.deepEqual(monitorsOf(null), [])
  assert.deepEqual(monitorsOf({ fan: [shell('b1', 'npm run dev')] }), [], 'a shell is not a monitor')
  const fan = [
    shell('b1', 'npm run dev'),
    monitor('m1', 'Watch the macOS and Ubuntu CI runs\nof the latest commit'),
    monitor('m2', 'Done one', { doneAt: 1_795_060_100_000 }),
    { id: 'a1', kind: 'artifact_watch', label: 'the design page' }
  ]
  assert.deepEqual(monitorsOf({ fan }).map((item) => [item.id, item.label]), [['m1', 'Watch the macOS and Ubuntu CI runs of the latest commit']], 'one that runs, in one line; a finished monitor and a watch of a page are not')
  assert.deepEqual(shellsOf({ fan }).map((item) => item.id), ['b1'], 'and the shells are as they were')
})

test('a session that waits on a monitor is not idle: its turn is over, but it goes on by itself when the monitor says something', async () => {
  const dir = home({
    registry: { 111: { status: 'shell' }, 222: { status: 'shell' }, 333: { status: 'busy' }, 444: { status: 'waiting' } },
    jobs: {
      b3c4d5e6: { tempo: 'idle', fan: [monitor('m5', 'Watch the CI runs')] },
      a1b2c3d4: { tempo: 'idle', fan: [monitor('m1', 'Watch the CI runs')] },
      e5f6a7b8: { tempo: 'idle', fan: [monitor('m2', 'Watch the CI runs'), shell('b2', 'npm run dev')] },
      c9d0e1f2: { tempo: 'active', fan: [monitor('m3', 'Watch the CI runs')] },
      d0e1f2a3: { tempo: 'idle', fan: [monitor('m4', 'Watch the CI runs', { doneAt: 1_795_060_100_000 })] },
      f1a2b3c4: { tempo: 'idle', fan: [monitor('m6', 'Watch the CI runs')] },
      f2b3c4d5: { tempo: 'active', fan: [monitor('m7', 'Watch the CI runs')] }
    }
  })
  const rows = await withShells(dir, [
    job(),
    job({ id: 'e5f6a7b8', pid: 222, sessionId: 's-2' }),
    job({ id: 'c9d0e1f2', pid: 333, sessionId: 's-3' }),
    job({ id: 'd0e1f2a3', pid: 111, sessionId: 's-4' }),
    job({ id: 'b3c4d5e6', pid: 444, sessionId: 's-5', status: 'waiting', waitingFor: 'permission prompt' }),
    job({ id: 'f1a2b3c4', pid: 555, sessionId: 's-6' }),
    job({ id: 'f2b3c4d5', pid: 666, sessionId: 's-7' })
  ])
  // The program's record says shell here (it does with a shell beside the monitor): the job's fan tells a monitor from a shell, and a monitor
  // makes the session busy whatever the record says.
  assert.deepEqual([rows[0].status, rows[0].monitors?.map((item) => item.label), rows[0].shells], ['busy', ['Watch the CI runs'], undefined], 'waiting on a monitor: busy, and what for')
  assert.equal(stateOfJob(rows[0]), 'working', 'so working, not idle')
  assert.deepEqual([rows[1].status, rows[1].monitors?.length, rows[1].shells?.length], ['busy', 1, 1], 'a monitor and a shell: working, and both said')
  assert.deepEqual([rows[2].status, rows[2].monitors?.length], ['busy', 1], 'at work, with a monitor: as it was, and the monitor said')
  assert.deepEqual([rows[3].status, rows[3].monitors], ['shell', undefined], "a monitor that has finished waits on nothing: the old rule (idle by the program's record)")
  assert.equal(stateOfJob(rows[3]), 'idle')
  assert.deepEqual([rows[4].status, rows[4].monitors?.length], ['waiting', 1], 'one that asks the person still asks: the monitor does not make it work')
  assert.equal(stateOfJob(rows[4]), 'waiting')
  // A list that calls the session idle (another version of Claude Code, or a stand-in) while a monitor runs: still working.
  const [idle] = await withShells(dir, [job({ status: 'idle' })])
  assert.deepEqual([idle.status, stateOfJob(idle)], ['busy', 'working'])
  // Whether its turn is over, so that only the monitor keeps it busy and there is no turn for Stop to end: by the program's record (shell), by the list
  // (idle), or with no record of the program, by the job's tempo (idle). A turn that runs (the record says busy, the tempo active) is not over.
  assert.deepEqual(rows.map((row) => row.turnOver), [true, true, undefined, undefined, undefined, true, undefined], 'over for the record that says shell, the list that says idle, and the idle tempo: not for a turn at work, a finished monitor, or a question')
  assert.equal(idle.turnOver, true, 'the list says idle: its turn is over')
})

test('Claude Code\'s own folder is where its program is told to keep it, else ~/.claude', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'C:\\somewhere' }), 'C:\\somewhere')
  assert.equal(claudeConfigDir({}), path.join(os.homedir(), '.claude'))
})
