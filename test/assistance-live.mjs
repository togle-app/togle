// Bounded opt-in evaluation using the selected Claude subscription and fictional meetings.
// Reads selected connector metadata; no microphone, desktop input, company-content lookup or preference write.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const data = path.join(process.env.APPDATA, 'togle')
process.env.TOGLE_TEST_USER_DATA = data
const T = await import('./.build/togle.mjs')
await T.loadSettings()
const settings = T.getSettings()
const owner = JSON.parse(await fs.readFile(path.join(data, 'agents', settings.activeAgentId + '.json'), 'utf8'))
const route = owner.preferences?.ai?.tasks.quick ?? settings.ai?.tasks.quick
assert.equal(route.sourceId, 'claude-default', 'This evaluation is scoped to the shared Claude account selected by this agent')
const provider = new T.ClaudeSubscriptionProvider(new T.ClaudeCodeAuth(), async () => ({ ...sdk, query: parameters => sdk.query({ ...parameters, options: { ...parameters.options, hooks: { ...parameters.options.hooks, PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This evaluation uses fictional content and needs no external tool.' } })] }] } } }) }))
if (owner.claudeConnections) {
  const catalog = await provider.connections()
  assert.equal(catalog.account.toLowerCase(), owner.claudeConnections.account.toLowerCase())
}
const agent = { ...owner, name: 'Fictional meeting replay', instructions: 'The user is Luka. Help him participate concisely. Respect questions addressed to other people. Separate proposals, verified facts and commitments. Never claim a deployment or deadline without evidence.', aboutMe: '', memory: [], factSources: {}, skills: [], answers: [], knowledge: [] }
const results = []
const cases = [
  { name: 'question for another speaker', lines: [['them', 'Roman, can you update us on your QA work?'], ['them', 'I have completed the acceptance test plan.']], quiet: true },
  { name: 'already answered by the user', lines: [['them', 'Luka, did you verify the integration tests?'], ['me', 'Yes, I ran them and all integration tests passed.']], quiet: true },
  { name: 'merged does not establish deployment', lines: [['them', 'The PR for fictional ticket APP-42 is merged. Deployment has not been verified.'], ['them', 'Luka, is APP-42 deployed?']], uncertain: true },
  { name: 'help without inventing a commitment', lines: [['them', 'Luka, can you promise delivery tomorrow?'], ['me', 'I have not estimated the remaining work yet.']], uncertain: true, manual: true }
]
for (const scenario of cases) {
  if (process.argv.includes('--reply-only') && !scenario.manual) continue
  if (process.argv.includes('--verify') && scenario.quiet) continue
  const transcript = scenario.lines.map(([speaker, text], index) => ({ id: 'fiction-' + index, speaker, text, at: 1000 + index * 3000, end: 2000 + index * 3000 }))
  const question = scenario.manual ? 'Help me respond without committing to an unverified delivery date.' : transcript.at(-1).text
  const prompt = T.buildPrompt({ agent, knowledge: { passages: [], documents: [], searchable: false, allSkills: true, allAnswers: true }, part: 'main', request: { kind: scenario.manual ? 'ask' : 'suggest', auto: !scenario.manual }, question, transcript, frames: [], attached: new Set(), canSearch: false })
  const started = performance.now(); let first, answer = '', usage
  await provider.stream({ ...prompt, lane: 'quick', model: route.model, effort: route.effort, claudeConnections: owner.claudeConnections }, { signal: AbortSignal.timeout(60_000), onDelta: text => { first ??= performance.now(); answer += text }, onUsage: value => { usage = value } })
  if (scenario.quiet) assert.match(answer, /^\s*LEVEL:\s*quiet\s*$/i, scenario.name)
  if (scenario.uncertain) assert.match(answer, /not|haven.t|can.t|cannot|before|unverified|confirm|check|verify|estimate|remaining/i, scenario.name)
  if (scenario.name.startsWith('merged')) { assert.match(answer, /not confirmed|not verified|unverified|haven.t verified|can.t confirm|cannot confirm/i); assert.doesNotMatch(answer, /LEVEL:\s*quick\s*\n\s*(?:Yes|Confirmed|It is deployed|It's deployed|APP-42 is deployed|Already deployed)/i) }
  if (scenario.manual) assert.doesNotMatch(answer, /\b(?:I|we)(?: can| will|'ll)\s+(?:promise|guarantee|deliver)\b.{0,25}\btomorrow/i)
  if (scenario.manual) assert.doesNotMatch(answer, /say something like|\btips:|^\s*[-*]\s/m, 'A live reply must be ready to say, without a second coaching section')
  const result = { scenario: scenario.name, pass: true, answer, firstTextMs: Math.round(first - started), totalMs: Math.round(performance.now() - started), phases: usage?.phases }
  results.push(result); console.log(JSON.stringify(result))
}
if (!process.argv.includes('--reply-only')) {
const learnPrompt = T.buildLearnPrompt(agent, [{ id: 'qa-1', speaker: 'them', text: 'Roman will write the acceptance scenarios before development. This is a proposal for the current feature.', at: 1000, end: 3000 }], [], undefined, [])
let lesson = ''
await provider.stream({ ...learnPrompt, lane: 'deep' }, { signal: AbortSignal.timeout(90_000), onDelta: text => { lesson += text } })
const learned = T.parseLessons(lesson)
assert.equal(learned.skills.filter(skill => skill.purpose === 'assistance').length, 0, 'An observed QA workflow cannot become a new assistant behavior')
assert.equal(learned.facts.length, 0, 'A proposal for one feature cannot become an enduring team policy')
results.push({ scenario: 'meeting content does not imply an assistance skill', pass: true, review: lesson })
}
const directory = path.resolve('test/.work/assistance-live'); await fs.mkdir(directory, { recursive: true })
await fs.writeFile(path.join(directory, process.argv.includes('--reply-only') ? 'reply.json' : process.argv.includes('--verify') ? 'verification.json' : 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), model: route.model, results }, null, 2))
console.log(`LIVE ASSISTANCE PASS: ${results.length} scenarios, fictional content only.`)
