// What the speech evaluation shares inside Electron: the copy of Togle's data that launch.cjs made, and the command
// line's options.
const { app } = require('electron')

/** Points Electron's userData at the copy launch.cjs made. Call before app 'ready'. */
function useCopyOfTogleData() {
  const copy = process.env.TOGLE_EVAL_DATA
  if (!copy) throw new Error('Start the evaluation with npm run speech (it runs on a copy of your data).')
  app.setPath('userData', copy)
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

module.exports = { useCopyOfTogleData, options, median, sleep, within, run }
