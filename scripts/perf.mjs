// Sums up the timings Togle logs during real calls (perf.jsonl in Togle's data folder; timings only, never words): how
// soon answers showed after the caller stopped talking, where the time went, and how speech was heard.
//   npm run perf                  everything in the log
//   npm run perf -- --days 7      the last week
//   npm run perf -- --file x.jsonl another log
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Togle's data folder, as Electron names it on this system (the packaged app's "Togle" on Linux, which tells case apart). */
function togleData() {
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? '') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return existsSync(path.join(base, 'togle')) ? path.join(base, 'togle') : path.join(base, 'Togle')
}

const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const file = option('--file') ?? path.join(togleData(), 'perf.jsonl')
if (!existsSync(file)) {
  console.log(`No timings yet (${file}). They're written during calls, from the next call on.`)
  process.exit(0)
}
const days = Number(option('--days')) || 0
const since = days ? Date.now() - days * 86_400_000 : 0
const records = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((r) => r && Date.parse(r.at) >= since)
const dismissed = records.filter((r) => r.type === 'answer' && r.dismissed)
const answers = records.filter((r) => r.type === 'answer' && !r.dismissed)
const heard = records.filter((r) => r.type === 'heard')
const requests = records.filter((r) => r.type === 'request')

const numbers = (xs) => xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
const at = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null)
const s = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(2)} s`)
/** "median 2.41 s, 9 in 10 within 3.80 s (n=40)" */
function spread(values) {
  const xs = numbers(values)
  return xs.length ? `median ${s(at(xs, 0.5))}, 9 in 10 within ${s(at(xs, 0.9))} (${xs.length})` : 'none yet'
}
const share = (part, whole) => (whole ? `${part} of ${whole} (${Math.round((100 * part) / whole)}%)` : '0')

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
console.log(
  `${count(answers.length, 'answer')} in ${count(answers.filter((a) => a.nthInCall === 0).length, 'call')}, ${count(heard.length, 'utterance')}` +
    `${days ? ` in the last ${days} days` : ''}\n`
)

const auto = answers.filter((a) => a.from === 'speech')
console.log('Automatic suggestions, from the caller\'s last word:')
console.log(`  words on screen        ${spread(auto.map((a) => a.shown))}`)
console.log(`    started at the pause ${spread(auto.filter((a) => a.atPause).map((a) => a.shown))}`)
console.log(`    after end of speech  ${spread(auto.filter((a) => !a.atPause).map((a) => a.shown))}`)
console.log(`    a call's first       ${spread(auto.filter((a) => a.nthInCall === 0).map((a) => a.shown))}`)
console.log(`    later in a call      ${spread(auto.filter((a) => a.nthInCall > 0).map((a) => a.shown))}`)
console.log(`  reply started          ${spread(auto.map((a) => a.request))}`)
console.log(`  local preparation      ${spread(answers.map((a) => a.providerStarted === undefined ? NaN : a.providerStarted - a.request).filter(Number.isFinite))}`)
console.log(`  provider first text    ${spread(auto.map((a) => a.providerStarted === undefined || a.modelText === undefined ? NaN : a.modelText - a.providerStarted).filter(Number.isFinite))} after local preparation`)
for (const [key, label] of Object.entries({ setupMs: 'provider setup', discoveryMs: 'connector catalog', runtimeMs: 'runtime startup', connectionsMs: 'connector readiness' })) {
  const measured = requests.filter(request => request.lane === 'quick' && request.phases)
  if (measured.length) console.log(`  ${label.padEnd(22)} ${spread(measured.map(request => request.phases[key]))}`)
}
console.log(`  second copies          ${share(auto.filter((a) => a.secondCopy).length, auto.length)}`)
console.log(`  errors                 ${share(answers.filter((a) => a.error).length, answers.length)}`)
if (dismissed.length) {
  console.log('\nAutomatic suggestions kept off screen:')
  for (const [reason, label] of [['quiet', 'no reply needed'], ['answered', 'already answered'], ['superseded', 'conversation moved on'], ['stopped', 'stopped before showing']]) {
    console.log(`  ${label.padEnd(24)} ${dismissed.filter((a) => a.dismissed === reason).length}`)
  }
}

const asked = answers.filter((a) => a.from === 'asked' && a.kind !== 'summary')
console.log(`\nAsked for (hotkey, typed), from asking: words on screen ${spread(asked.map((a) => a.shown))}`)
const deep = answers.filter((a) => a.deep)
console.log(`Deep answers: first words ${spread(deep.map((a) => a.deep.firstText))}; done ${spread(deep.map((a) => a.deep.done))}`)

const tokens = answers.filter((a) => a.tokens)
const inputs = numbers(tokens.map((a) => a.tokens.input))
const cached = tokens.reduce((n, a) => n + a.tokens.cached, 0)
const input = tokens.reduce((n, a) => n + a.tokens.input, 0)
console.log(`Quick answers' prompts: median ${at(inputs, 0.5) ?? '-'} tokens, the largest ${inputs.at(-1) ?? '-'}; ${input ? Math.round((100 * cached) / input) : 0}% from the cache`)
const models = [...new Set(answers.map((a) => `${a.model ?? '?'} ${a.effort ?? ''}${a.fast ? ' fast' : ''}`))]
console.log(`Models: ${models.join(', ') || '-'}`)

// Every request to the model, by what it was for: answers, descriptions of the screen, notes and reviews.
if (requests.length) {
  console.log('\nModel requests (all of them, stopped ones too):')
  const LANES = { quick: 'quick answers', deep: 'deep answers, Train', vision: 'screen pictures', background: 'notes, summaries' }
  for (const [lane, label] of Object.entries(LANES)) {
    const rs = requests.filter((r) => r.lane === lane)
    if (!rs.length) continue
    const done = rs.filter((r) => r.end === 'done')
    const input = done.reduce((n, r) => n + r.input, 0)
    const cachedIn = done.reduce((n, r) => n + r.cached, 0)
    const stopped = rs.filter((r) => r.end === 'stopped').length
    const failed = rs.filter((r) => r.end === 'failed').length
    console.log(
      `  ${label.padEnd(15)} ${String(rs.length).padStart(5)}${stopped ? `, ${stopped} stopped` : ''}${failed ? `, ${failed} failed` : ''}; ` +
        `prompts median ${at(numbers(done.map((r) => r.input)), 0.5) ?? '-'} tokens, ${input ? Math.round((100 * cachedIn) / input) : 0}% from the cache`
    )
  }
}

// The ChatGPT plan's limits as they moved: every rise counts toward what this stretch used (a drop is a window
// starting over).
const plans = records.filter((r) => r.type === 'plan' && r.windows?.length)
if (plans.length) {
  const limitName = (m) => (m === 10080 ? 'weekly' : m === 1440 ? 'daily' : m % 60 === 0 ? `${m / 60}-hour` : `${m}-minute`)
  console.log('\nChatGPT plan:')
  for (const minutes of [...new Set(plans.flatMap((p) => p.windows.map((w) => w.minutes)))].sort((a, b) => a - b)) {
    const used = plans.map((p) => p.windows.find((w) => w.minutes === minutes)?.used).filter((u) => typeof u === 'number')
    const rose = used.reduce((sum, u, i) => sum + (i ? Math.max(0, u - used[i - 1]) : 0), 0)
    console.log(`  ${limitName(minutes)} limit: ${used.at(-1)}% used at the last answer; this stretch used ${rose} points of it`)
  }
  const reached = plans.filter((p, i) => p.limited && !plans[i - 1]?.limited).length
  if (reached) console.log(`  reached ${count(reached, 'time')}`)
}

const whisper = heard.filter((h) => h.by === 'whisper')
console.log(`\nSpeech: Whisper heard ${share(whisper.length, heard.length)}; noisy lines ${share(heard.filter((h) => h.noisy).length, heard.length)}`)
console.log(`  transcribing: Parakeet ${spread(heard.filter((h) => h.by === 'parakeet').map((h) => h.ms))}; Whisper ${spread(whisper.map((h) => h.ms))}`)
// The speech APIs picked in Settings for a side, when there were any.
for (const [by, name] of [
  ['openai', 'OpenAI'],
  ['server', 'the speech server']
]) {
  const lines = heard.filter((h) => h.by === by)
  if (lines.length) console.log(`  ${name} heard ${share(lines.length, heard.length)}: ${spread(lines.map((h) => h.ms))}`)
}
