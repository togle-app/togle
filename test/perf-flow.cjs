// Real OS encryption and the production renderer, with fictional calls and no accounts, devices or model requests.
// Run through npm run perf:app. Timings are descriptive; assertions cover bounded work and data integrity.
const { app, BrowserWindow, safeStorage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const project = path.resolve(__dirname, '..')
const artifacts = path.join(__dirname, '.work', 'perf')
fs.mkdirSync(artifacts, { recursive: true })
const profile = fs.mkdtempSync(path.join(artifacts, 'profile-'))
app.setPath('userData', profile)
process.env.TOGLE_TEST_USER_DATA = profile
app.on('window-all-closed', () => {})
let checkpoint = 'startup'
const timeout = setTimeout(() => { console.error('Performance check timed out at ' + checkpoint); app.exit(1) }, 60000)
const elapsed = start => Math.round((performance.now() - start) * 100) / 100
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const fake = (await import(pathToFileURL(path.join(__dirname, 'electron.mjs')).href)).default
  let decryptions = 0
  fake.safeStorage.isEncryptionAvailable = () => safeStorage.isEncryptionAvailable()
  fake.safeStorage.encryptString = text => safeStorage.encryptString(text)
  fake.safeStorage.decryptString = buffer => { decryptions++; return safeStorage.decryptString(buffer) }
  const T = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  const store = new T.AgentStore(async () => { throw new Error('Performance checks must not use a model.') })
  await store.load()
  const agent = store.list()[0]
  const info = id => ({ id, agentId: agent.id, agentName: agent.name, startedAt: 1000, endedAt: 9000, status: 'ended' })
  const state = count => ({ transcript: Array.from({ length: count }, (_, index) => ({ id: 'line-' + index, speaker: index % 2 ? 'me' : 'them', text: index === count - 1 ? 'Needle: final decision is to send the report by Tuesday.' : 'A realistic meeting turn about the product rollout, open questions, responsibilities and the next steps for the team. ' + index, at: 1000 + index * 1000, end: 1900 + index * 1000 })), frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: 'Large meeting performance check', group: false })
  const repo = new T.CallSessions()
  checkpoint = 'seed encrypted calls'
  for (let index = 0; index < 60; index++) await repo.capture(info('call-' + index), 'frames-' + index, state(200))
  const longState = state(20000)
  const cards = Array.from({ length: 200 }, (_, index) => ({ id: 'reply-' + index, kind: 'suggest', question: 'What should we confirm next? ' + index, text: 'Confirm the owner and due date before committing. ' + index, at: index * 1000 }))
  await repo.capture(info('long-call'), 'frames-long', longState, { cards, reviewedLines: 0 })
  const cold = new T.CallSessions()
  const coldStart = performance.now()
  assert.equal((await cold.list()).length, 61)
  const coldListMs = elapsed(coldStart)
  const readTimes = []
  const beforeReads = decryptions
  for (let index = 0; index < 12; index++) {
    const start = performance.now()
    const record = await cold.get('long-call')
    assert.equal(record.transcript.length, 20000)
    assert.match(record.transcript.at(-1).text, /Needle/)
    readTimes.push(elapsed(start))
  }
  const repeatedReadDecryptions = decryptions - beforeReads
  const captureTimes = []
  checkpoint = 'save long call'
  for (let index = 0; index < 5; index++) {
    const start = performance.now()
    await cold.capture(info('long-call'), 'frames-long', longState, { cards, reviewedLines: index })
    captureTimes.push(elapsed(start))
  }
  const record = await cold.get('long-call')
  const names = [...fs.readFileSync(path.join(project, 'src/shared/api.ts'), 'utf8').matchAll(/^  (\w+)\(/gm)].map(match => match[1])
  const settings = structuredClone(T.getSettings())
  settings.activeAgentId = agent.id
  settings.provider = 'claude'
  settings.claude.auth = 'subscription'
  settings.transcription.me = settings.transcription.them = 'local'
  const fixture = { settings, names, agents: [agent], sessions: [record], transcript: longState.transcript, scenario: 'performance', readyAudio: true, templates: T.AGENT_TEMPLATES }
  const preload = path.join(profile, 'preload.cjs')
  fs.writeFileSync(preload, 'require(' + JSON.stringify(path.join(__dirname, 'ui-fixture.cjs')) + ')(' + JSON.stringify(fixture) + ')')
  const window = new BrowserWindow({ show: false, width: 640, height: 850, webPreferences: { preload, sandbox: false, offscreen: true, backgroundThrottling: false } })
  const errors = []
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const evaluate = code => window.webContents.executeJavaScript(code)
  const paint = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const wait = async code => {
    for (let index = 0; index < 150; index++) { if (await evaluate(code)) return; await sleep(20) }
    throw new Error('Did not reach: ' + code)
  }
  checkpoint = 'renderer startup'
  const rendererStart = performance.now()
  await window.loadFile(path.join(project, 'out/renderer/index.html'))
  await wait("!!document.querySelector('.composer')&&!!document.querySelector('.agent-detail-tabs')")
  await paint()
  const rendererReadyMs = elapsed(rendererStart)
  await evaluate("document.querySelector('#agent-tab-calls').click()")
  await wait("!!document.querySelector('.past-call-row')")
  await evaluate("document.querySelector('.past-call-row:not(.current-call-row)').click()")
  await wait("!!document.querySelector('.call-detail-tabs')")
  await paint()
  checkpoint = 'open 20,000-line transcript'
  const transcriptStart = performance.now()
  await evaluate("document.querySelector('[role=tab][aria-label=Transcript]').click()")
  await wait("!!document.querySelector('.history-transcript-line')")
  await paint()
  const transcriptOpenMs = elapsed(transcriptStart)
  const transcriptDomRows = await evaluate("document.querySelectorAll('.history-transcript-line').length")
  checkpoint = 'search final line of long transcript'
  const searchStart = performance.now()
  await evaluate("(()=>{const input=document.querySelector('[aria-label=\"Search transcript\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Needle:');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await wait("document.querySelectorAll('.history-transcript-line').length===1&&document.querySelector('.history-transcript-line').textContent.includes('Needle:')")
  await paint()
  const transcriptSearchMs = elapsed(searchStart)
  if (!process.argv.includes('--baseline')) {
    assert.ok(repeatedReadDecryptions <= 1, 'reopening the same archive must reuse its decrypted content')
    assert.ok(transcriptDomRows <= 100, 'opening a long call must keep the initial transcript DOM bounded')
    checkpoint = 'incremental transcript and suggestions'
    await evaluate("(()=>{const input=document.querySelector('[aria-label=\"Search transcript\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await wait("document.querySelectorAll('.history-transcript-line').length===100")
    await evaluate("document.querySelector('.history-more').click()")
    await wait("document.querySelectorAll('.history-transcript-line').length===200")
    assert.match(T.exportCall(record), /Needle: final decision/)
    await evaluate("document.querySelector('[role=tab][aria-label=Replies]').click()")
    await wait("document.querySelectorAll('.history-suggestion').length===25")
    await evaluate("document.querySelector('.history-more').click()")
    await wait("document.querySelectorAll('.history-suggestion').length===50")
    checkpoint = 'ignore changes to other calls while inspecting an archive'
    const beforeRefresh = await evaluate("window.togleUITest.calls().filter(call=>call.name==='callSession'||call.name==='callSessions').length")
    await evaluate("window.togleUITest.emit('onCallSessions',{id:'another-call'})")
    await paint()
    assert.equal(await evaluate("window.togleUITest.calls().filter(call=>call.name==='callSession'||call.name==='callSessions').length"), beforeRefresh)
  }
  checkpoint = 'open current call transcript'
  await evaluate("document.querySelector('.sidebar-agent').click()")
  await evaluate("document.querySelector('#agent-tab-calls').click()")
  await wait("!!document.querySelector('.current-call-row')")
  await evaluate("document.querySelector('.current-call-row').click()")
  await wait("!!document.querySelector('.call-links')")
  const liveStart = performance.now()
  await evaluate("[...document.querySelectorAll('.call-links button')].find(b=>/^(Transcript|What was said)$/.test(b.textContent.trim())).click()")
  await wait("!!document.querySelector('.timeline-panel .line')")
  await paint()
  const liveTranscriptOpenMs = elapsed(liveStart)
  const liveTranscriptDomRows = await evaluate("document.querySelectorAll('.timeline-panel .line').length")
  if (!process.argv.includes('--baseline')) {
    assert.equal(liveTranscriptDomRows, 100)
    assert.ok(await evaluate("document.querySelector('.timeline-panel').textContent.includes('Needle:')"))
    await evaluate("document.querySelector('.timeline-earlier').click()")
    await paint()
    assert.equal(await evaluate("document.querySelectorAll('.timeline-panel .line').length"), 200)
  }
  const captionTimes = []
  for (let index = 0; index < 12; index++) {
    const start = performance.now()
    await evaluate("window.togleUITest.emit('onTranscript', {id:'new-' + " + index + ",speaker:'them',text:'The latest live call words ' + " + index + ",at:Date.now(),end:Date.now()})")
    await paint()
    captionTimes.push(elapsed(start))
  }
  assert.ok(await evaluate("document.querySelector('.timeline-panel').textContent.includes('The latest live call words 11')"))
  assert.deepEqual(errors, [])
  const results = { scenario: '61 encrypted calls; one 20,000-line call with 200 replies; 20,000-line current transcript', coldListMs, warmReadMedianMs: median(readTimes.slice(1)), repeatedReadDecryptions, saveMedianMs: median(captureTimes), rendererReadyMs, transcriptOpenMs, transcriptSearchMs, transcriptDomRows, liveTranscriptOpenMs, liveTranscriptDomRows, liveUpdateMedianMs: median(captionTimes) }
  const label = process.argv.includes('--baseline') ? 'baseline' : 'latest'
  fs.writeFileSync(path.join(artifacts, label + '.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
  window.destroy()
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error(checkpoint + ':', error.stack); clearTimeout(timeout); app.exit(1) })
