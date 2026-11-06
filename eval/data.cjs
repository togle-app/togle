// What every evaluation shares inside Electron: the copy of Togle's data that launch.cjs made, the ChatGPT
// sign-in from it, the requests it makes with it, the agents they're measured with, and the command line's options.
const { app } = require('electron')
const { AsyncLocalStorage } = require('node:async_hooks')
const fs = require('node:fs')
const path = require('node:path')

const SIGN_IN = 'chatgpt-auth.bin'

/** Points Electron's userData at the copy launch.cjs made. Call before app 'ready'. */
function useCopyOfTogleData() {
  const copy = process.env.TOGLE_EVAL_DATA
  if (!copy) throw new Error('Start evaluations with npm run eval or npm run e2e (they run on a copy of your data).')
  app.setPath('userData', copy)
}

/**
 * ChatGPT access with the copied sign-in, used as it is. It is never refreshed: a refresh rotates the
 * refresh token, which would sign the real Togle out. The copy's file is deleted as soon as it's read, so no
 * sign-in is left behind even if the run is killed.
 */
async function signIn(readSecret) {
  const tokens = await readSecret(SIGN_IN)
  fs.rmSync(path.join(app.getPath('userData'), SIGN_IN), { force: true })
  if (!tokens) throw new Error('The copied ChatGPT sign-in could not be read.')
  const fresh = () => tokens.expiresAt - Date.now() > 15 * 60_000
  if (!fresh()) throw new Error('The ChatGPT sign-in expires within 15 minutes. Open Togle once so it refreshes it, then run again.')
  return {
    getAccess: async () => {
      if (!fresh()) throw new Error('The ChatGPT sign-in is about to expire; stopping instead of refreshing it.')
      return { accessToken: tokens.accessToken, accountId: tokens.accountId }
    }
  }
}

/**
 * Every request the provider makes to the plan, counted where it's sent: one answer can make several (a lookup is
 * one more round, a slow answer gets a second copy, a dropped connection a retry). Each is noted by the lane of the
 * answer it was for; past `most`, requests fail instead of going out.
 */
function countRequests(provider, most = Infinity) {
  if (typeof provider.round !== 'function') throw new Error('The ChatGPT provider has no round() to count requests at: count them where it sends them now.')
  const requests = []
  const answering = new AsyncLocalStorage()
  const stream = provider.stream.bind(provider)
  provider.stream = (input, handlers) => answering.run(input.lane, () => stream(input, handlers))
  const round = provider.round.bind(provider)
  provider.round = (...args) => {
    if (requests.length >= most) return Promise.reject(new Error(`No more requests: --max-requests ${most} are used.`))
    requests.push(answering.getStore() ?? 'other')
    return round(...args)
  }
  return requests
}

// The setups the evaluations were measured with, from when Togle had them as templates (its agents for a kind of call
// are in the market now). Kept here as they were, so results stay comparable with earlier runs.
const SETUPS = {
  sales: {
    name: 'Sales call',
    description: 'Discovery, demos, objections, closing',
    instructions: `You are my sales copilot.
- Qualify as we go: their need, budget, who decides, timeline. Suggest the next discovery question when one is missing.
- Handle objections with specifics from my knowledge (pricing, features, case studies), not generic lines.
- Quote prices and terms exactly as in my knowledge; never improvise discounts.
- Point out buying signals and risks, and steer toward a concrete next step (demo, trial, proposal, date).`
  },
  support: {
    name: 'Customer support',
    description: 'Troubleshooting and calm problem-solving',
    instructions: `You help me resolve customer issues on calls.
- Pin down the problem first: what they tried, what they see, account or version details.
- Suggest troubleshooting steps from my knowledge base, one or two at a time.
- Acknowledge frustration briefly, then move to the fix.
- Never promise what policy doesn't allow; suggest escalation when the fix is out of my hands.`
  },
  meeting: {
    name: 'Team meeting',
    description: 'Work calls with company knowledge',
    instructions: `You help me in work meetings at my company.
- Answer technical and product questions from my company knowledge; say when the knowledge doesn't cover it.
- Suggest useful points, risks or questions I could raise.
- Keep track of decisions and anything assigned to me.`
  }
}

/** A new agent set up for a kind of call (sales, support, meeting), as the evaluations were measured with. */
function agentFor(store, kind, patch = {}) {
  if (!SETUPS[kind]) throw new Error(`No setup for ${kind} calls.`)
  return store.create('blank', { ...SETUPS[kind], ...patch })
}

/** `--name value` pairs and bare `--flag`s from the command line, as launch.cjs passed them on. */
function options(argv = JSON.parse(process.env.TOGLE_EVAL_ARGS ?? '[]')) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const name = /^--([\w-]+)$/.exec(argv[i])?.[1]
    if (!name) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[name] = next
      i++
    } else out[name] = true
  }
  return out
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Rejects when a step takes longer than it should, instead of hanging the run. */
function within(ms, what, promise) {
  let timer
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Runs an evaluation and quits, whether it worked or not. */
function run(main) {
  app.whenReady().then(main).then(
    () => app.exit(0),
    (err) => {
      console.error(`FAILED: ${err.message}`)
      app.exit(1)
    }
  )
}

module.exports = { useCopyOfTogleData, signIn, countRequests, agentFor, options, median, sleep, within, run }
