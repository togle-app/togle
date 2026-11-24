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
  await repo.capture(info('long-call'), 'frames-long', longState)
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
    await cold.capture(info('long-call'), 'frames-long', { ...longState, marks: [index] })
    captureTimes.push(elapsed(start))
  }
  const record = await cold.get('long-call')
  const names = [...fs.readFileSync(path.join(project, 'src/shared/api.ts'), 'utf8').matchAll(/^  (\w+)\(/gm)].map(match => match[1])
  const settings = structuredClone(T.getSettings())
  settings.activeAgentId = agent.id
  settings.provider = 'chatgpt'
  settings.transcription.me = settings.transcription.them = 'local'
  const fixture = { settings, names, agents: [agent], sessions: [record], transcript: longState.transcript, scenario: 'performance', readyAudio: true }
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
  await wait("!!document.querySelector('.workspace-nav')")
  await paint()
  const rendererReadyMs = elapsed(rendererStart)
  await evaluate("document.querySelector('.workspace-nav button[aria-label=\"Meetings\"]').click()")
  await wait("!!document.querySelector('.meeting-row')")
  await evaluate("document.querySelector('.meeting-row').click()")
  await wait("!!document.querySelector('.call-detail-tabs')")
  await paint()
  checkpoint = 'open 20,000-line transcript'
  const transcriptStart = performance.now()
  await evaluate("document.querySelector('#meeting-tab-transcript').click()")
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
    checkpoint = 'more of the transcript'
    await evaluate("(()=>{const input=document.querySelector('[aria-label=\"Search transcript\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await wait("document.querySelectorAll('.history-transcript-line').length===100")
    await evaluate("document.querySelector('.history-more').click()")
    await wait("document.querySelectorAll('.history-transcript-line').length===200")
    assert.match(T.exportCall(record), /Needle: final decision/)
    checkpoint = 'ignore changes to other calls while a call is open'
    const beforeRefresh = await evaluate("window.togleUITest.calls().filter(call=>call.name==='callSession'||call.name==='callSessions').length")
    await evaluate("window.togleUITest.emit('onCallSessions',{id:'another-call'})")
    await paint()
    assert.equal(await evaluate("window.togleUITest.calls().filter(call=>call.name==='callSession'||call.name==='callSessions').length"), beforeRefresh)
  }
  checkpoint = 'a call written down that grows to 5,000 lines'
  await evaluate("document.querySelector('[aria-label=\"Back to Meetings\"]').click()")
  await wait("!!document.querySelector('.page-head .primary')")
  await evaluate("[...document.querySelectorAll('.page-head .primary')].find(b=>b.textContent==='Write down now').click()")
  await wait("!!document.querySelector('.meeting-consent button[type=submit], .live-lines')")
  await evaluate("document.querySelector('.meeting-consent button[type=submit]')?.click()")
  await wait("!!document.querySelector('.live-lines')")
  const liveStart = performance.now()
  await evaluate("for(let i=0;i<5000;i++)window.togleUITest.emit('onTranscript',{id:'live-'+i,speaker:i%2?'me':'them',text:(i===4999?'Needle: ':'')+'A realistic meeting turn about the rollout, open questions and who does what next. '+i,at:Date.now()+i,end:Date.now()+i})")
  await wait("document.querySelectorAll('.live-lines .live-line').length>=5000")
  await paint()
  const liveFillMs = elapsed(liveStart)
  const liveTranscriptDomRows = await evaluate("document.querySelectorAll('.live-lines .live-line').length")
  if (!process.argv.includes('--baseline')) assert.ok(await evaluate("document.querySelector('.live-lines').textContent.includes('Needle:')"))
  const captionTimes = []
  for (let index = 0; index < 12; index++) {
    const start = performance.now()
    await evaluate("window.togleUITest.emit('onTranscript', {id:'new-' + " + index + ",speaker:'them',text:'The latest live call words ' + " + index + ",at:Date.now(),end:Date.now()})")
    await paint()
    captionTimes.push(elapsed(start))
  }
  assert.ok(await evaluate("document.querySelector('.live-lines').textContent.includes('The latest live call words 11')"))
  assert.deepEqual(errors, [])
  const results = { scenario: '61 encrypted calls; one 20,000-line call in Meetings; a call written down that grows to 5,000 lines', coldListMs, warmReadMedianMs: median(readTimes.slice(1)), repeatedReadDecryptions, saveMedianMs: median(captureTimes), rendererReadyMs, transcriptOpenMs, transcriptSearchMs, transcriptDomRows, liveFillMs, liveTranscriptDomRows, liveUpdateMedianMs: median(captionTimes), liveUpdateMaxMs: Math.max(...captionTimes) }
  const label = process.argv.includes('--baseline') ? 'baseline' : 'latest'
  fs.writeFileSync(path.join(artifacts, label + '.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
  window.destroy()
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error(checkpoint + ':', error.stack); clearTimeout(timeout); app.exit(1) })
