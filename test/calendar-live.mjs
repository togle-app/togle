// Explicit live check of the production reminder flow using the signed-in Claude account.
// Reads calendar events only. Does not start a call, record audio, or change the calendar.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const directory = path.resolve('test/.work/calendar-live')
mkdirSync(directory, { recursive: true })
process.env.TOGLE_TEST_USER_DATA = directory
const { CalendarReminders, ClaudeCodeAuth, ClaudeSubscriptionProvider } = await import('./.build/togle.mjs')
const completed = new Set()
const failed = new Set()
const provider = new ClaudeSubscriptionProvider(new ClaudeCodeAuth(), async () => ({ ...sdk,
  query: parameters => sdk.query({ ...parameters, options: { ...parameters.options, hooks: { ...parameters.options.hooks,
    PostToolUse: [{ hooks: [async event => { if (event.hook_event_name === 'PostToolUse') completed.add(event.tool_name); return {} }] }],
    PostToolUseFailure: [{ hooks: [async event => { if (event.hook_event_name === 'PostToolUseFailure') failed.add(event.tool_name); return {} }] }]
  } } })
}))
const started = performance.now()
const catalog = await provider.connections(true)
const calendars = catalog.apps.filter(app => /calendar/i.test(app.label))
console.log(JSON.stringify({ account: catalog.account, calendars }))
assert.ok(calendars.some(app => app.status === 'connected' && app.readTools > 0), 'Calendar must be connected with read access')
const reminders = new CalendarReminders(provider, () => true, () => false, () => {}, () => {})
try {
  const status = await reminders.refresh()
  const report = { checkedAt: new Date().toISOString(), state: status.state, account: status.account,
    events: status.events.map(event => ({ title: event.title, start: new Date(event.start).toISOString(), end: new Date(event.end).toISOString(), attendees: event.attendees })),
    error: status.error, completed: [...completed], failed: [...failed], durationMs: Math.round(performance.now() - started) }
  writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.equal(status.state, 'ready', status.error)
  assert.ok([...completed].some(name => /calendar/i.test(name)), 'A real calendar read must complete')
  assert.ok([...completed].every(name => name === 'ToolSearch' || /calendar/i.test(name)), 'Only calendar tools may execute')
  assert.equal(failed.size, 0, 'Calendar tools must succeed')
} finally { reminders.stop() }
