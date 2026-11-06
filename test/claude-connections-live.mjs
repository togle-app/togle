// Explicit live check: uses the current Claude account to read connector metadata.
// Never opens issues/messages or writes to a connected service. Not part of npm test.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const directory = path.resolve('test/.work/claude-connections-live')
mkdirSync(directory, { recursive: true })
process.env.TOGLE_TEST_USER_DATA = directory
const { ClaudeCodeAuth, ClaudeSubscriptionProvider } = await import('./.build/togle.mjs')
const completed = new Set()
const failed = new Set()
const provider = new ClaudeSubscriptionProvider(new ClaudeCodeAuth(), async () => ({ ...sdk,
  query: parameters => sdk.query({ ...parameters, options: { ...parameters.options, hooks: { ...parameters.options.hooks,
    PostToolUse: [{ hooks: [async event => { if (event.hook_event_name === 'PostToolUse') completed.add(event.tool_name); return {} }] }],
    PostToolUseFailure: [{ hooks: [async event => { if (event.hook_event_name === 'PostToolUseFailure') failed.add(event.tool_name); return {} }] }]
  } } })
}))
const catalog = await provider.connections(true)
const servers = ['claude.ai Slack', 'claude.ai Atlassian']
for (const name of servers) assert.ok(catalog.apps.some(app => app.name === name && app.status === 'connected'), `Connect ${name} in Claude before running this check`)
let answer = ''
const started = performance.now()
await provider.stream({
  lane: 'quick', model: 'claude-haiku-4-5', effort: 'low', maxToolRounds: 3,
  claudeConnections: { account: catalog.account, servers },
  system: 'Verify read-only connections. Do not modify anything or open any issue, file, or message. Output JSON only, with keys slack_ok and jira_ok, based on actual tool results. Do not return any company content.',
  user: 'Actually call getAccessibleAtlassianResources to verify Jira access and slack_search_channels with query "engineering" to verify Slack access. Use ToolSearch first if needed. Never pretend to call a tool. Report false for a failed or unavailable tool.'
}, { signal: AbortSignal.timeout(90_000), onDelta: text => { answer += text } })
assert.ok(completed.has('mcp__claude_ai_Slack__slack_search_channels'), 'Slack lookup must actually complete')
assert.ok(completed.has('mcp__claude_ai_Atlassian__getAccessibleAtlassianResources'), 'Atlassian lookup must actually complete')
assert.equal(failed.size, 0, 'no tool execution errors')
// Streamed tool-use narration may precede the final JSON object.
const json = JSON.parse(answer.match(/\{[^{}]*\}/g)?.findLast(block => block.includes('"slack_ok"') && block.includes('"jira_ok"')) ?? '{}')
assert.equal(json.slack_ok, true)
assert.equal(json.jira_ok, true)
const report = { checkedAt: new Date().toISOString(), completed: [...completed], failed: [...failed], durationMs: Math.round(performance.now() - started) }
writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
