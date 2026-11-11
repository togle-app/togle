// The agents, for notice-flow.cjs: Hermes is a stand-in program (fake-hermes.mjs) run by Electron as plain Node. The real
// app reads this through TOGLE_TEST_RUNNERS, in a run from source only.
const path = require('node:path')
const { pathToFileURL } = require('node:url')

module.exports = {
  async backends() {
    const T = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
    return [new T.HermesBackend({ command: [process.execPath, path.join(__dirname, 'fake-hermes.mjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })]
  }
}
