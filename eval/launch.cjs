// Runs an evaluation in Electron on a private copy of Togle's data (agents, settings, the ChatGPT sign-in),
// and deletes the copy once Electron has exited: while it runs, Electron keeps files in it open.
//   node eval/launch.cjs eval/run.cjs [options]     (what `npm run eval` and `npm run e2e` do)
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('electron')

/** Togle's data folder, as Electron names it on this system (the packaged app's "Togle" on Linux, which tells case apart). */
function togleData() {
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? '') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return fs.existsSync(path.join(base, 'togle')) ? path.join(base, 'togle') : path.join(base, 'Togle')
}

const SOURCE = togleData()
const SIGN_IN = 'chatgpt-auth.bin'
const [script, ...args] = process.argv.slice(2)
// A dry run uses no model, so it gets no sign-in.
const signedIn = !args.includes('--dry')

if (signedIn && !fs.existsSync(path.join(SOURCE, SIGN_IN))) {
  console.error(`No ChatGPT sign-in in ${SOURCE}: sign in to Togle first.`)
  process.exit(1)
}
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-eval-'))
for (const name of ['settings.json', 'Local State', ...(signedIn ? [SIGN_IN] : [])]) {
  if (fs.existsSync(path.join(SOURCE, name))) fs.copyFileSync(path.join(SOURCE, name), path.join(copy, name))
}
if (fs.existsSync(path.join(SOURCE, 'agents'))) fs.cpSync(path.join(SOURCE, 'agents'), path.join(copy, 'agents'), { recursive: true })

// The options travel in the environment: on Electron's command line an argument like gpt-6-luna:low (a colon,
// as in a URL) makes it exit before the script runs.
const child = spawn(electron, [script], {
  stdio: 'inherit',
  env: { ...process.env, TOGLE_EVAL_DATA: copy, TOGLE_EVAL_ARGS: JSON.stringify(args) }
})
const removeCopy = () => fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())
child.on('exit', (code) => {
  removeCopy()
  process.exit(code ?? 1)
})
