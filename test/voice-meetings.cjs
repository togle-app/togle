// Evaluate identity on manually annotated natural meetings, including short replies and handoffs.
// Turn boundaries come from the public words, never speaker names from the model under test.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url')
const { readWave } = require('sherpa-onnx-node')
const assert = require('node:assert/strict')
const reference = require('./voice-meetings-reference.json')
const folder = path.join(__dirname, '.work/voice-meetings')
const profile = fs.mkdtempSync(path.join(folder, 'profile-'))
app.setPath('userData', profile)
process.env.TOGLE_TEST_USER_DATA = profile
const timeout = setTimeout(() => { console.error('Meeting test timed out'); app.exit(1) }, 180000)
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'current'

function turnsOf(words) {
  const turns = []
  for (const speaker of ['A', 'B', 'C', 'D']) for (const word of words.filter(word => word.speaker === speaker)) {
    const previous = turns.at(-1)
    if (previous?.speaker === speaker && word.start - previous.end <= .6 && word.end - previous.start <= 8) previous.end = word.end
    else turns.push({ speaker, start: word.start, end: word.end })
  }
  return turns.filter(turn => turn.end - turn.start >= .7).map(turn => {
    const competing = words.filter(word => word.speaker !== turn.speaker && word.end > turn.start && word.start < turn.end)
    const overlap = competing.reduce((sum, word) => sum + Math.max(0, Math.min(word.end, turn.end) - Math.max(word.start, turn.start)), 0)
    return { ...turn, overlap, duration: turn.end - turn.start }
  }).sort((a, b) => a.start - b.start)
}

app.whenReady().then(async () => {
  const { VoiceClusters, VoiceMemory, VOICE_MODEL } = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  const model = process.env.TOGLE_TEST_EMBEDDING
  const worker = utilityProcess.fork(process.env.TOGLE_VOICE_WORKER || path.resolve(__dirname, '../out/main/voice-worker.js'), [model, process.env.TOGLE_TEST_SEGMENTATION], { stdio: 'ignore' })
  let pending
  await new Promise((resolve, reject) => worker.on('message', message => {
    if (message.type === 'ready') resolve()
    else if (message.type === 'failed') reject(new Error(message.error))
    else if (message.type === 'result') { const done = pending; pending = undefined; done(message) }
  }))
  const reports = [], all = []
  for (const meeting of ['ES2002a', 'ES2003a']) {
    const wave = readWave(path.join(folder, meeting + '.wav'), false)
    if (wave.sampleRate !== 16000) throw new Error('Expected 16 kHz meeting audio')
    const words = JSON.parse(fs.readFileSync(path.join(folder, meeting + '.json'), 'utf8'))
    const turns = turnsOf(words), cache = path.join(folder, label + '-' + meeting + '-raw.json')
    const results = process.argv.includes('--cached') && fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : []
    for (const [index, turn] of (results.length ? [] : turns).entries()) {
      const id = meeting + '-' + index, at = Math.max(0, turn.start - .08), end = turn.end + .08
      // AMI's headset mix is much quieter than ordinary call playback. A fixed gain for the
      // entire meeting preserves relative voice levels; it never uses a speaker annotation.
      const pcm = Float32Array.from(wave.samples.subarray(Math.floor(at * 16000), Math.ceil(end * 16000)), sample => Math.max(-1, Math.min(1, sample * 12)))
      const began = performance.now()
      const message = await new Promise(resolve => { pending = resolve; worker.postMessage({ id, pcm }) })
      results.push({ ...turn, ...message, embedding: message.embedding && Array.from(message.embedding), ms: performance.now() - began, at: at * 1000, end: end * 1000 })
    }
    fs.writeFileSync(path.join(folder, label + '-' + meeting + '-raw.json'), JSON.stringify(results))
    // Enrollment and evaluation use distinct utterances. Meeting 2 is held out while changing rules.
    const memory = new VoiceMemory(VOICE_MODEL.sha256), enrolled = new Set(), identities = new Map()
    for (const speaker of ['A', 'B', 'C', 'D']) {
      const examples = results.filter(row => row.speaker === speaker && reference.meetings[meeting].enrollment.includes(row.id) && row.embedding)
      if (examples.length !== 3) throw new Error('Could not recognize the fixed enrollment clips for ' + meeting + speaker)
      examples.forEach(row => enrolled.add(row.id))
      identities.set(speaker, (await memory.remember(meeting + speaker, examples.map(row => new Float32Array(row.embedding)))).id)
    }
    const clusters = new VoiceClusters(), bindings = new Map(), assignments = new Map(), scored = []
    const metrics = { single: { correct: 0, wrong: 0, unknown: 0 }, short: { correct: 0, wrong: 0, unknown: 0 }, mixed: { labeled: 0, rejected: 0 }, wrong: [] }
    for (const row of results.filter(row => !enrolled.has(row.id))) {
      const embedding = row.embedding && new Float32Array(row.embedding)
      const evidence = embedding ? memory.recognize(embedding, row.seconds, row.clean !== false) : undefined
      for (const assignment of clusters.observe({ ...row, embedding, identity: evidence?.person?.id, identities: evidence?.ranked })) {
        const profile = clusters.profile(assignment.voice)
        if (!bindings.has(assignment.voice)) {
          const person = profile.identity ? memory.get(profile.identity) : profile.count >= 2 && profile.seconds >= 6 ? memory.match(profile.samples) : undefined
          if (person) { bindings.set(assignment.voice, person.id); clusters.remember(assignment.voice, person.id) }
        }
        assignments.set(assignment.id, { voice: assignment.voice, identity: bindings.get(assignment.voice) })
      }
      scored.push(row)
    }
    const clustersByPerson = new Map()
    for (const row of scored) {
      const assignment = assignments.get(row.id), expected = identities.get(row.speaker)
      if (row.overlap >= .4) { metrics.mixed[assignment ? 'labeled' : 'rejected']++; continue }
      if (row.overlap >= .08) continue // Boundary ambiguity is reported separately, not scored as one voice.
      const key = !assignment?.identity ? 'unknown' : assignment.identity === expected ? 'correct' : 'wrong'
      metrics.single[key]++
      if (row.duration < 2) metrics.short[key]++
      if (key === 'wrong') metrics.wrong.push({ id: row.id, speaker: row.speaker, predicted: memory.get(assignment.identity)?.name, at: row.at, seconds: row.seconds })
      if (assignment) { const set = clustersByPerson.get(row.speaker) ?? new Set(); set.add(assignment.voice); clustersByPerson.set(row.speaker, set) }
    }
    const durations = results.map(row => row.ms).sort((a, b) => a - b)
    const report = { meeting, turns: results.length, ...metrics, profiles: clusters.size, profilesPerSpeaker: Object.fromEntries([...clustersByPerson].map(([speaker, ids]) => [speaker, ids.size])), latency: { medianMs: Math.round(durations[Math.floor(durations.length / 2)]), p95Ms: Math.round(durations[Math.floor(durations.length * .95)]) } }
    reports.push(report); all.push({ meeting, enrollment: [...enrolled], results })
    console.log(JSON.stringify(report))
    // Independent stores for each meeting, so absent identities cannot affect its confidence margin.
    for (const person of await memory.list()) await memory.forget(person.id)
  }
  fs.writeFileSync(path.join(folder, label + '-embeddings.json'), JSON.stringify(all))
  fs.writeFileSync(path.join(folder, label + '-report.json'), JSON.stringify(reports, null, 2))
  if (!process.argv.includes('--report-only')) for (const report of reports) {
    assert.equal(report.single.wrong, 0, report.meeting + ': one person cannot receive another person’s name')
    assert.ok(report.single.correct / (report.single.correct + report.single.unknown) >= .65, report.meeting + ': preserve useful recognition coverage')
    assert.ok(report.mixed.labeled / (report.mixed.labeled + report.mixed.rejected) <= .3, report.meeting + ': reject most mixed-speaker turns')
    assert.ok(report.profiles <= 4, report.meeting + ': do not invent extra people')
    assert.ok(Object.values(report.profilesPerSpeaker).every(count => count <= 1), report.meeting + ': keep one stable label per person')
    assert.equal(report.turns, reference.meetings[report.meeting].turns)
  }
  worker.kill(); clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
