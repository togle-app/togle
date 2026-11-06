/** Explicit acceptance checks, not a claim that a scripted model measures answer quality. */
function checkScenario(scenario, result) {
  const checks = []
  const check = (label, pass) => checks.push({ label, pass: !!pass })
  check('expected decision: ' + scenario.decision, result.decision === scenario.decision)
  check('expected service errors', result.errors.length === (scenario.expectedErrors ?? 0))
  check('finished within deadline', !result.timedOut)
  if (scenario.decision === 'shown') check('nonempty useful output', !!result.text.trim())
  else check('no visible card', result.cards === 0)
  if (scenario.noRequest) check('no unnecessary model request', result.requests === 0)
  for (const pattern of scenario.prompt ?? []) check('context: ' + pattern.source, pattern.test(result.prompt))
  for (const [label, pattern] of scenario.require ?? []) check(label, pattern.test(result.text))
  for (const [label, pattern] of scenario.forbid ?? []) check(label + ' absent', !pattern.test(result.text))
  checks.push(...(result.behavior ?? []))
  return { pass: checks.every(c => c.pass), checks }
}

module.exports = { checkScenario }
