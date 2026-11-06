import assert from 'node:assert/strict'
import { test } from 'node:test'
import cases from '../eval/realistic-cases.cjs'
import checks from '../eval/scenario-checks.cjs'

const result = (text, extra = {}) => ({ decision: 'shown', cards: 1, text, errors: [], requests: 1, timedOut: false, prompt: 'Growth costs 29 euros. SSO requires Enterprise.', ...extra })

test('a realistic sales check rejects the wrong total and a missing plan restriction', () => {
  assert.ok(checks.checkScenario(cases[0], result('Growth costs 232 euros. SSO requires Enterprise.')).pass)
  assert.ok(!checks.checkScenario(cases[0], result('Growth costs 240 euros. SSO requires Enterprise.')).pass)
  assert.ok(!checks.checkScenario(cases[0], result('Growth costs 232 euros.')).pass)
})
test('private-fact checks accept placeholders and reject invented revenue', () => {
  assert.ok(checks.checkScenario(cases[2], result('Our annual recurring revenue is [ARR].')).pass)
  assert.ok(!checks.checkScenario(cases[2], result('Our annual recurring revenue is $500,000.')).pass)
})
test('quiet checks reject a visible interruption or unnecessary model request', () => {
  const quiet = { decision: 'quiet', cards: 0, text: '', errors: [], requests: 0, timedOut: false, prompt: '' }
  assert.ok(checks.checkScenario(cases[3], quiet).pass)
  assert.ok(!checks.checkScenario(cases[3], { ...quiet, cards: 1 }).pass)
  assert.ok(!checks.checkScenario(cases[3], { ...quiet, requests: 1 }).pass)
})
test('otherwise correct answers fail on timeouts, service errors, or missing source context', () => {
  const text = 'Growth costs 232 euros. SSO requires Enterprise.'
  for (const extra of [{ timedOut: true }, { errors: ['connection failed'] }, { prompt: '' }]) {
    assert.ok(!checks.checkScenario(cases[0], result(text, extra)).pass)
  }
})
