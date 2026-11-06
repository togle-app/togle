// Prints a quality evaluation's answers next to what a good answer does: node eval/show.cjs [label] [case ids...]
const path = require('node:path')

const [label = 'latest', ...only] = process.argv.slice(2)
const results = require(path.join(__dirname, 'results', `${label}.json`))
for (const r of results) {
  if (only.length && !only.includes(r.id)) continue
  console.log(`\n=== ${r.id} ${r.title}`)
  console.log(`expect: ${r.expect}`)
  if (r.decision) console.log(`decision: ${r.decision}${r.expectedDecision ? ` (expected ${r.expectedDecision}, ${r.decisionPassed ? 'pass' : 'FAIL'})` : ''}${r.dismissed ? `; ${r.dismissed}` : ''}`)
  console.log(`question: ${r.question}`)
  if (r.match) console.log(`approved answer shown: ${r.match}`)
  for (const fact of r.facts ?? []) console.log(`from the documents: ${fact.text} (${fact.doc})`)
  if (r.decision !== 'quiet') console.log(`quick answer (first words ${r.mainFirstMs} ms, done ${r.mainDoneMs} ms):\n${r.main}`)
  if (r.deep) console.log(`deep answer (first words ${r.deepFirstMs} ms, done ${r.deepDoneMs} ms):\n${r.deep}`)
  if (r.deepDropped) console.log('deep answer: dropped (judged quick)')
  if (r.errors?.length) console.log(`errors: ${r.errors.join(' | ')}`)
  for (const u of r.usage ?? []) {
    console.log(`  [${u.lane} ${u.model}] in ${u.input} (cached ${u.cached}), out ${u.output} (reasoning ${u.reasoning}), first text ${u.firstTextMs ?? '-'} ms, total ${u.ms} ms`)
  }
}
