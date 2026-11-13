// The agents, for notice-flow.cjs: an agent that speaks ACP, as Hermes did before it had its own screen, is a stand-in program
// (fake-hermes.mjs) run by Electron as plain Node: its tasks are conversations Togle shows, with cards to answer. The real
// app reads this through TOGLE_TEST_RUNNERS, in a run from source only.
const path = require('node:path')
const { pathToFileURL } = require('node:url')

module.exports = {
  async backends() {
    const T = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
    return [
      new T.AcpBackend({
        runner: 'hermes',
        name: 'Hermes',
        command: async () => [process.execPath, path.join(__dirname, 'fake-hermes.mjs'), 'acp'],
        versionOf: async () => 'Hermes Agent v0.0.0-fake',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
    ]
  }
}
