import assert from 'node:assert/strict'
import { test } from 'node:test'
import cases from '../eval/realistic-cases.cjs'
import replay from '../eval/replay-scenario.cjs'
import { workDir } from './helpers.mjs'

workDir('realistic')
const T = await import('./.build/togle.mjs')
await T.updateSettings({ assist: { auto: true, names: 'Luka' } })
for (const scenario of cases) {
  test(scenario.id + ': ' + scenario.title, { timeout: 10000 }, async () => {
    const result = await replay.replayScenario(T, scenario, replay.scriptedProvider, { timeoutMs: 7000 })
    assert.ok(result.pass, JSON.stringify(result.checks.filter(c => !c.pass)))
  })
}
