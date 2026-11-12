// The window of the product design, with isolated accounts, silent audio and a fake IPC API: To-do at home, a call
// written down from Meetings, its words and names as people speak, and after it, who spoke and its notes.
// No real account, microphone, downloads or model requests are used.
const { app, BrowserWindow, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
// Hosted Intel Macs have no usable EGL display; these fixtures render in software, as the other window tests do.
app.disableHardwareAcceleration()

const project = path.resolve(__dirname, '..')
const artifacts = path.join(__dirname, '.work', 'shell')
const data = path.join(artifacts, 'data-' + process.pid)
fs.mkdirSync(data, { recursive: true })
app.setPath('userData', data)
process.env.TOGLE_TEST_USER_DATA = data
app.on('window-all-closed', () => {})
let checkpoint = 'startup'
const timeout = setTimeout(() => { console.error('Window checks timed out at ' + checkpoint); app.exit(1) }, 300000)

async function open(T, agent, scenario, width = 1024, height = 850, surface) {
  checkpoint = scenario + ' at ' + width + 'px'
  const settings = structuredClone(T.getSettings())
  // The plan is ChatGPT's, not signed in yet (the fixture's ChatGPT account is signed out).
  settings.provider = 'chatgpt'
  settings.dictation.accountId = ''
  settings.transcription.language = 'en'
  settings.activeAgentId = agent.id
  settings.transcription.me = settings.transcription.them = 'local'
  // Voices are remembered only when turned on; the first-call notice is said once, in its own scenario.
  settings.assist.rememberVoices = scenario === 'ready'
  settings.meetings.introSeen = scenario !== 'first-call'
  // The first minute is gone through once; only its own scenarios have not.
  settings.firstMinute = { done: !scenario.startsWith('first-minute') }
  const names = [...fs.readFileSync(path.join(project, 'src/shared/api.ts'), 'utf8').matchAll(/^  (\w+)\(/gm)].map(m => m[1])
  const richText = scenario === 'rich-text' ? require('./rich-text-fixtures.cjs').reply : undefined
  // F8 Show: a frozen screen at twice the window's size, as on a screen scaled to 200%.
  const showPicture = scenario === 'show' ? { dataUrl: nativeImage.createFromBitmap(Buffer.alloc(width * 2 * height * 2 * 4, 0x60), { width: width * 2, height: height * 2 }).toDataURL(), width: width * 2, height: height * 2 } : undefined
  const fixture = JSON.stringify({ showPicture, settings, names, agents: [agent], scenario, readyAudio: !['speech', 'first-minute-new'].includes(scenario), templates: T.AGENT_TEMPLATES, richText })
  const preload = path.join(artifacts, 'preload-' + scenario + '-' + width + '.cjs')
  fs.writeFileSync(preload, 'const fixture=' + fixture + '\nrequire(' + JSON.stringify(path.join(__dirname, 'ui-fixture.cjs')) + ')(fixture)')
  const errors = []
  const window = new BrowserWindow({ show: false, width, height, webPreferences: { preload, sandbox: false, backgroundThrottling: false, offscreen: true } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  // A picture in the notes must never be fetched: every request for one is counted and refused.
  const remoteRequests = []
  if (richText) window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://never-fetch.example.invalid/*'] }, (request, callback) => { remoteRequests.push(request.url); callback({ cancel: true }) })
  const evaluate = async code => {
    checkpoint = scenario + ': ' + code.slice(0, 180)
    try { return await window.webContents.executeJavaScript(code) }
    catch (error) { throw new Error(error.message + '\nWhile running: ' + code + '\n' + errors.join('\n')) }
  }
  const paint = async () => {
    // A hidden offscreen renderer can stop receiving animation frames on macOS: yield without waiting forever.
    await evaluate('new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}))})')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  const wait = async code => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(code)) return paint()
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    const detail = await evaluate("({text:document.body.innerText.slice(0,2000),calls:window.togleUITest?.calls().slice(-10)})").catch(error => ({ error: error.message }))
    fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify({ scenario, width, condition: code, errors, detail }, null, 2))
    try { fs.writeFileSync(path.join(artifacts, 'failure.png'), (await window.webContents.capturePage()).toPNG()) } catch {}
    throw new Error('Window did not reach: ' + code + '\n' + JSON.stringify({ scenario, width, errors, detail }, null, 2))
  }
  const click = async (selector, label) => {
    await evaluate("(()=>{const button=[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find(e=>e.getClientRects().length&&(e.textContent.trim()===" + JSON.stringify(label) + "||e.getAttribute('aria-label')===" + JSON.stringify(label) + "));if(!button)throw new Error('Missing button: '+" + JSON.stringify(label) + ");button.click()})()")
    await paint()
  }
  const fill = async (selector, value) => {
    await evaluate("(()=>{const el=document.querySelector(" + JSON.stringify(selector) + ");const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el," + JSON.stringify(value) + ");el.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await paint()
  }
  const capture = async name => {
    await paint()
    fs.writeFileSync(path.join(artifacts, name + '.png'), (await window.webContents.capturePage()).toPNG())
  }
  const calls = name => evaluate('window.togleUITest.calls().filter(call=>call.name===' + JSON.stringify(name) + ').map(call=>call.args)')
  const emit = (name, value) => evaluate('window.togleUITest.emit(' + JSON.stringify(name) + ',' + JSON.stringify(value) + ')')
  // Nothing is wider than the window: the page never scrolls sideways.
  const fitsWidth = async () => {
    const sizes = await evaluate('({page:document.documentElement.scrollWidth,window:innerWidth})')
    assert.ok(sizes.page <= sizes.window, 'nothing is cut off at the side: ' + JSON.stringify(sizes))
  }
  await window.loadFile(process.env.TOGLE_UI_RENDERER || path.join(project, 'out/renderer/index.html'), surface ? { query: { surface } } : undefined)
  await wait(surface ? "document.body.classList.contains('" + surface + "-surface')" : "!!document.querySelector('.workspace-nav')")
  return { window, errors, remoteRequests, evaluate, paint, wait, click, fill, capture, calls, emit, fitsWidth }
}

const LIVE = "document.querySelector('section[aria-label=\"Call being written down\"]')"
const texts = (ui, selector) => ui.evaluate('[...document.querySelectorAll(' + JSON.stringify(selector) + ")].map(e=>e.textContent.trim().replace(/\\s+/g,' '))")
const place = ui => ui.evaluate("document.querySelector('.workspace-nav button[aria-current=page]')?.getAttribute('aria-label')")

/** The window's places, home, and a call written down from start to its page afterwards. */
async function checkCall(T, agent) {
  const ui = await open(T, agent, 'ready')
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.workspace-nav button')].map(b=>b.getAttribute('aria-label'))"), ['To-do', 'Agents', 'Meetings', 'Settings'])
  assert.equal(await place(ui), 'To-do', 'To-do is home')
  assert.equal(await ui.evaluate("!!document.querySelector('.todo')"), true)
  await ui.capture('home')

  await ui.click('.workspace-nav button', 'Meetings')
  await ui.wait("document.querySelectorAll('.meetings .meeting-row').length===1")
  assert.ok((await texts(ui, '.meeting-row'))[0].includes('Acme renewal'))
  assert.equal(await ui.evaluate(LIVE), null, 'no call is written down until asked')
  await ui.click('.meetings .page-head button', 'Write down now')
  await ui.wait('!!' + LIVE)
  assert.deepEqual(await ui.calls('setListening'), [[true]])
  const order = await ui.evaluate("window.togleUITest.calls().map(call=>call.name).filter(name=>['clearTranscript','prepareCallMicrophone','setListening'].includes(name))")
  assert.deepEqual(order, ['clearTranscript', 'prepareCallMicrophone', 'setListening'], 'a new call each time; Togle Studio is asked before the audio opens')
  assert.equal(await ui.evaluate('window.togleUITest.settings().assist.auto'), false, 'nothing is suggested during a call unasked')
  assert.ok(await ui.evaluate("!!document.querySelector('.live-call-link')"), 'the title bar says a call is being written down')
  assert.ok(await ui.evaluate("!!document.querySelector('.workspace-nav button[aria-label=\"Meetings\"] .dot.live')"))
  assert.deepEqual(await texts(ui, '.live-sources > span'), ['You', 'Call'])
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.live-head button')].map(b=>b.textContent.trim())"), ['Mark', 'Stop'])

  // The line to tell the others stays until it is ticked, and says where the sound goes.
  assert.equal(await ui.evaluate("document.querySelector('.tell-others .tell-line')?.textContent"), "I'm writing this call down with Togle. The sound stays on my computer, and an AI writes the notes from the words.")
  await ui.click('.tell-others button', 'Copy the line')
  assert.equal(await ui.evaluate("document.querySelectorAll('.tell-others').length"), 1, 'copying the line is not telling them')

  // The words as people speak: who said them, a guessed name with a question mark, a voice not named yet.
  const now = Date.now()
  await ui.emit('onTranscript', { id: 'l1', speaker: 'them', voiceId: 'voice:1', voiceName: 'Dario', voiceNamedBy: 'user', text: 'Can we ship the pricing page with two plans first?', at: now - 9000, end: now - 8000 })
  await ui.emit('onTranscript', { id: 'l2', speaker: 'them', voiceId: 'voice:2', voiceName: 'Marta', voiceNamedBy: 'suggested', text: 'Then the API timeline has to move to the end of the month.', at: now - 7000, end: now - 6000 })
  await ui.emit('onTranscript', { id: 'l3', speaker: 'them', voiceId: 'voice:4', text: 'I can take the staging logs.', at: now - 5000, end: now - 4000 })
  await ui.emit('onTranscript', { id: 'l4', speaker: 'me', text: 'Sounds good to me.', at: now - 3000, end: now - 2500 })
  await ui.wait("document.querySelectorAll('.live-line').length===4")
  assert.deepEqual(await texts(ui, '.live-line .who'), ['Dario', 'Marta?', 'Voice 4', 'You'])
  assert.deepEqual(await texts(ui, '.live-people .person-chip'), ['You', 'Dario', 'Marta?', 'Voice 4'])
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.live-people .person-chip')].map(c=>c.classList.contains('guess'))"), [false, false, true, false], 'only the guess looks like one')

  // Mark flags the moment: the line just said is marked, and the button counts the marks.
  await ui.click('.live-head button', 'Mark')
  await ui.wait("document.querySelector('.live-line:last-child .marked-tag')?.textContent==='Marked'")
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.live-head button')][0].textContent.trim()"), 'Mark 1')
  assert.equal((await ui.calls('markCall')).length, 1)
  await ui.click('.tell-others button', 'I told them')
  await ui.wait("!document.querySelector('.tell-others')")
  assert.deepEqual(await ui.calls('setToldOthers'), [[true]])

  // A caption while someone speaks (after the mark, so the mark stays where it was); the finished line replaces it, and
  // a late caption for it is not shown again.
  const later = (await ui.evaluate('Date.now()')) + 1000
  await ui.emit('onPartialTranscript', { segmentId: 'p1', speaker: 'them', voiceId: 'voice:1', voiceName: 'Dario', voiceNamedBy: 'user', text: 'And one more', at: later })
  await ui.wait("document.querySelector('.live-line.partial')?.textContent.includes('And one more')")
  await ui.emit('onTranscript', { id: 'l5', segmentId: 'p1', speaker: 'them', voiceId: 'voice:1', voiceName: 'Dario', voiceNamedBy: 'user', text: 'And one more thing.', at: later, end: later + 800 })
  await ui.emit('onPartialTranscript', { segmentId: 'p1', speaker: 'them', text: 'a late caption', at: later })
  await ui.wait("!document.querySelector('.live-line.partial')&&[...document.querySelectorAll('.live-line p')].some(p=>p.textContent==='And one more thing.')")
  assert.ok(!(await ui.evaluate('document.body.textContent.includes("a late caption")')))

  // A name is given or confirmed with a click on the voice.
  await ui.click('.live-people .person-chip', 'Voice 4')
  await ui.wait("!!document.querySelector('.person-chip.naming input')")
  assert.equal(await ui.evaluate("document.querySelector('.person-chip.naming input').getAttribute('aria-label')"), 'Name for Voice 4')
  await ui.fill('.person-chip.naming input', 'Ivan')
  await ui.click('.person-chip.naming button', 'Save')
  await ui.wait("[...document.querySelectorAll('.live-line .who')].some(who=>who.textContent==='Ivan')")
  assert.deepEqual((await ui.calls('renameVoice')).map(args => args.slice(0, 2)), [['voice:4', 'Ivan']])
  await ui.click('.live-people .person-chip', 'Marta?')
  assert.equal(await ui.evaluate("document.querySelector('.person-chip.naming input').value"), 'Marta', 'the guess is there to confirm')
  await ui.click('.person-chip.naming button', 'Save')
  await ui.wait("[...document.querySelectorAll('.live-people .person-chip')].some(chip=>chip.textContent==='Marta')")
  await ui.capture('live-call')

  // From another place, the title bar leads back to the call.
  await ui.click('.workspace-nav button', 'To-do')
  await ui.wait("!!document.querySelector('.todo')")
  await ui.click('.titlebar button', 'Open the call being written down')
  await ui.wait('!!' + LIVE)
  assert.equal(await place(ui), 'Meetings')

  // Narrow: everything still fits, the places become icons.
  for (const [width, height] of [[640, 760], [420, 760]]) {
    ui.window.setSize(width, height)
    await ui.paint()
    await ui.fitsWidth()
    await ui.capture('live-call-' + width)
  }
  ui.window.setSize(1024, 850)
  await ui.paint()

  // Stop: the call's own page opens, with its notes and its transcript.
  await ui.click('.live-head button', 'Stop')
  await ui.wait("!!document.querySelector('.meeting-detail .call-detail-tabs')")
  assert.deepEqual(await ui.calls('setListening'), [[true], [false]])
  assert.equal(await ui.evaluate(LIVE), null)
  assert.equal(await ui.evaluate("!!document.querySelector('.live-call-link')"), false)
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.meeting-detail [role=tab]')].map(tab=>tab.textContent)"), ['Notes', 'Transcript'])
  await ui.click('.meeting-detail [role=tab]', 'Transcript')
  await ui.wait("[...document.querySelectorAll('.meeting-detail .history-transcript-line')].some(line=>line.textContent.includes('staging logs'))")
  await ui.capture('after-call')
  await ui.click('.meeting-detail button', 'Back to Meetings')
  await ui.wait("document.querySelectorAll('.meetings .meeting-row').length===2")
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()

  // The call app's notice ("Write it down") starts a call without the window, and the same message ends it.
  const unseen = await open(T, agent, 'ready', 640)
  await unseen.emit('onHotkey', 'start-call-unseen')
  await unseen.wait('!!' + LIVE)
  await unseen.emit('onHotkey', 'start-call-unseen')
  await unseen.wait('!' + LIVE)
  assert.deepEqual(await unseen.calls('setListening'), [[true], [false]])
  assert.deepEqual(unseen.errors, [])
  unseen.window.destroy()
  console.log('Window and call: To-do at home, write down now, the line to tell the others, names and guesses, Mark, captions, naming a voice, the way back from another place, narrow sizes, Stop to the call page, and the call app notice passed.')
}

/** The first call says two things plainly, once. */
async function checkFirstCall(T, agent) {
  const ui = await open(T, agent, 'first-call', 640)
  await ui.click('.workspace-nav button', 'Meetings')
  await ui.click('.meetings .page-head button', 'Write down now')
  await ui.wait("!!document.querySelector('.first-call')")
  const said = await ui.evaluate("document.querySelector('.first-call').textContent")
  assert.match(said, /rules for writing down a call differ by place/)
  assert.match(said, /The words of the call go to the AI you set up/)
  assert.match(said, /The sound stays on this computer\./)
  await ui.capture('first-call')
  await ui.click('.first-call button', 'Got it')
  await ui.wait("!document.querySelector('.first-call')")
  assert.equal(await ui.evaluate('window.togleUITest.settings().meetings.introSeen'), true)
  await ui.click('.live-head button', 'Stop')
  await ui.wait("!!document.querySelector('.meeting-detail')")
  await ui.click('.meeting-detail button', 'Back to Meetings')
  await ui.click('.meetings .page-head button', 'Write down now')
  await ui.wait('!!' + LIVE)
  assert.equal(await ui.evaluate("!!document.querySelector('.first-call')"), false, 'said once')
  assert.equal(await ui.evaluate("!!document.querySelector('.tell-others')"), true, 'the line to tell the others comes with every call')
  await ui.click('.live-head button', 'Stop')
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()
}

/** After a call: who spoke, and the Meetings screen with search, a call's page and giving it to an agent. */
async function checkMeetings(T, agent) {
  const ui = await open(T, agent, 'confirm-names')
  await ui.click('.workspace-nav button', 'Meetings')
  await ui.wait("document.querySelectorAll('.meetings .meeting-row').length===3")
  const rowText = title => "(([...document.querySelectorAll('.meeting-row')].find(row=>row.textContent.includes(" + JSON.stringify(title) + ")))||{textContent:''}).textContent"
  assert.ok((await ui.evaluate(rowText('Sprint review'))).includes('2 names to confirm'), 'a row says what is left to do')
  assert.ok((await ui.evaluate(rowText('Design check'))).includes('1 name to confirm'))
  assert.ok((await ui.evaluate(rowText('Acme renewal'))).includes('done'))
  await ui.capture('meetings')
  await ui.fill('[aria-label="Search what was said"]', 'staging logs')
  await ui.wait("document.querySelectorAll('[aria-label=\"Search results\"] .meeting-row').length===1")
  assert.ok((await ui.evaluate("document.querySelector('[aria-label=\"Search results\"]').textContent")).includes('I can take the staging logs.'), 'search shows the line with the words')
  await ui.fill('[aria-label="Search what was said"]', 'zebra')
  await ui.wait("document.querySelector('[aria-label=\"Search results\"]').textContent.includes('Nothing said in your recent calls')")
  await ui.fill('[aria-label="Search what was said"]', '')
  await ui.wait("document.querySelectorAll('.meeting-row').length===3")

  await ui.click('.meeting-row', 'Open call: Sprint review')
  await ui.wait("!!document.querySelector('.meeting-detail .confirm-names')")
  const panel = "document.querySelector('.confirm-names').textContent"
  assert.ok((await ui.evaluate(panel)).includes('Who spoke?2 of 2 to confirm'))
  assert.ok((await ui.evaluate(panel)).includes('Dario said “Marta” just before.'))
  assert.ok((await ui.evaluate(panel)).includes('Closes after your last answer. The sound is deleted then, or tomorrow at the latest.'))
  await ui.capture('confirm-names')
  await ui.click('.confirm-names button', 'Play Marta?')
  await ui.wait("window.togleUITest.calls().some(call=>call.name==='confirmSound'&&call.args[1]==='v0')")
  await ui.click('.confirm-names button', 'Yes')
  await ui.wait("document.querySelector('.confirm-names').textContent.includes('1 of 2 to confirm')")
  await ui.fill('.confirm-names input[aria-label="Name for Voice 2"]', 'Ivan')
  await ui.click('.confirm-names button', 'Save')
  await ui.wait("!document.querySelector('.confirm-names')")
  assert.deepEqual((await ui.calls('confirmAnswer')).map(args => args.slice(1)), [['voice:1', 'Marta'], ['voice:2', 'Ivan']], 'the last answer closes it')
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.meeting-detail [role=tab]')].map(tab=>tab.textContent)"), ['Notes', 'Transcript'])
  assert.ok((await ui.evaluate("document.querySelector('.meeting-detail .call-detail-head .hint').textContent")).includes('you did not tick'), 'the call says whether the others were told')
  await ui.click('.meeting-detail .call-record-actions button', 'Give to an agent')
  await ui.wait("window.togleUITest.calls().some(call=>call.name==='giveCallToAgent'&&call.args[0]==='confirm-call')")
  await ui.click('.meeting-detail button', 'Back to Meetings')
  await ui.click('.meeting-row', 'Open call: Design check')
  await ui.wait("!!document.querySelector('.confirm-names')")
  await ui.click('.confirm-names button', 'Skip the rest and delete the sound')
  await ui.wait("!document.querySelector('.confirm-names')")
  assert.equal((await ui.calls('confirmFinish')).length, 1)

  // While a call is written down, Meetings is the call, and its list waits behind it.
  await ui.click('.meeting-detail button', 'Back to Meetings')
  await ui.click('.meetings .page-head button', 'Write down now')
  await ui.wait('!!' + LIVE)
  await ui.click('.workspace-nav button', 'Agents')
  await ui.click('.workspace-nav button', 'Meetings')
  await ui.wait('!!' + LIVE)
  await ui.click('.live-head button', 'Stop')
  for (const width of [640, 420]) {
    ui.window.setSize(width, 800)
    await ui.paint()
    await ui.fitsWidth()
    await ui.capture('call-page-' + width)
  }
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()
  console.log('Meetings: rows with what is left, search, who spoke with a guess, a name and a skip, the call page and giving it to an agent, and a call written down from there passed.')
}

/** What can go wrong at the start of a call: no speech recognition yet, a microphone not allowed, a start that fails. */
async function checkProblems(T, agent) {
  // Without speech recognition on this computer, Write down now leads to where it is set up.
  const setup = await open(T, agent, 'speech', 640)
  await setup.click('.workspace-nav button', 'Meetings')
  await setup.click('.meetings .page-head button', 'Write down now')
  await setup.wait("document.activeElement?.id==='settings-speech'")
  assert.ok((await setup.evaluate("document.querySelector('#settings-speech').textContent")).includes('Install'), 'with the way to get it')
  assert.equal(await place(setup), 'Settings')
  assert.deepEqual(await setup.calls('setListening'), [])
  assert.deepEqual(setup.errors, [])
  setup.window.destroy()

  // Real silent streams with a microphone that is not allowed: the call goes on with the call's sound, and says so.
  const installAudio = ui => ui.evaluate(`(async()=>{
    const engine=new AudioContext();await engine.resume();
    const source=engine.createMediaStreamDestination();
    const audio={micAllowed:false,callAllowed:true,micCalls:0,callCalls:0,streams:[],engine};
    const make=()=>{const stream=source.stream.clone();audio.streams.push(stream);return stream};
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async options=>{
      if(options?.audio?.deviceId?.exact==='fixture-monitor'){audio.callCalls++;if(!audio.callAllowed)throw new Error('Call audio disconnected');return make()}
      audio.micCalls++;if(!audio.micAllowed)throw new Error('Microphone permission denied');return make()
    }});
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{audio.callCalls++;if(!audio.callAllowed)throw new Error('Call audio disconnected');return make()}});
    Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{configurable:true,value:async()=>/Linux/.test(navigator.userAgent)?[{deviceId:'fixture-monitor',kind:'audioinput',label:'Monitor of Fixture speakers'}]:[]});
    window.audioFixture=audio;
  })()`)
  const audio = await open(T, agent, 'audio', 640)
  await installAudio(audio)
  await audio.click('.workspace-nav button', 'Meetings')
  await audio.click('.meetings .page-head button', 'Write down now')
  await audio.wait("!!document.querySelector('.live-problem')")
  assert.ok((await audio.evaluate("document.querySelector('.live-problem').textContent")).includes("Togle can't hear your microphone. It still hears the call."))
  assert.deepEqual(await audio.evaluate("[...document.querySelectorAll('.live-sources > span')].map(s=>s.dataset.state)"), ['off', 'on'])
  await audio.capture('microphone-not-allowed')
  await audio.evaluate('window.audioFixture.micAllowed=true')
  await audio.click('.live-problem button', 'Reconnect audio')
  await audio.wait("!document.querySelector('.live-problem')&&document.querySelector('.live-sources > span').dataset.state==='on'")
  assert.equal(await audio.evaluate('window.audioFixture.callCalls'), 1, "the call's sound was not opened again")
  assert.deepEqual(await audio.calls('setListening'), [[true]], 'the call went on')
  await audio.click('.live-head button', 'Stop')
  assert.ok(await audio.evaluate("window.audioFixture.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))"), 'every device is let go')
  assert.deepEqual(audio.errors, [])
  await audio.evaluate('window.audioFixture.engine.close()')
  audio.window.destroy()

  // A start that fails says why, lets the devices go, and the next start works.
  const failed = await open(T, agent, 'start-failure', 640)
  await installAudio(failed)
  await failed.evaluate('window.audioFixture.micAllowed=true')
  await failed.click('.workspace-nav button', 'Meetings')
  await failed.click('.meetings .page-head button', 'Write down now')
  await failed.wait("[...document.querySelectorAll('.notice')].some(e=>e.textContent.includes('Call service could not start'))")
  assert.equal(await failed.evaluate(LIVE), null)
  assert.ok(await failed.evaluate("window.audioFixture.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))"))
  await failed.click('.meetings .page-head button', 'Write down now')
  await failed.wait('!!' + LIVE)
  await failed.click('.live-head button', 'Stop')
  assert.deepEqual((await failed.calls('setListening')).map(args => args[0]), [true, false, true, false])
  assert.deepEqual(failed.errors, [])
  await failed.evaluate('window.audioFixture.engine.close()')
  failed.window.destroy()
  console.log('Problems: no speech recognition yet, a microphone not allowed and reconnected, and a start that fails passed.')
}

/** A noisy room: after the call, what the microphone picked up, and both ways to stop it. */
async function checkNoisyCall(T, agent) {
  for (const width of [640, 1024]) {
    const ui = await open(T, agent, 'noisy-call', width)
    await ui.click('.workspace-nav button', 'Meetings')
    await ui.click('.meetings .page-head button', 'Write down now')
    await ui.wait('!!' + LIVE)
    assert.equal(await ui.evaluate("!!document.querySelector('.studio-mention')"), false, 'nothing about Togle Studio during a call')
    await ui.click('.live-head button', 'Stop')
    // One line on the call's page, with one link.
    await ui.wait("!!document.querySelector('.meeting-detail .studio-mention')")
    assert.equal(await ui.evaluate("document.querySelector('.studio-mention').textContent"), 'Your microphone picked up room noise for 3 of 10 minutes. Clean my microphone')
    assert.equal(await ui.evaluate("document.querySelectorAll('.studio-mention button').length"), 1)
    assert.equal((await ui.calls('noiseMeasured'))[0][0].sample, undefined, 'the audio stays in the window: main gets levels only')
    await ui.fitsWidth()
    await ui.capture('noisy-call-' + width)
    await ui.click('.studio-mention button', 'Clean my microphone')
    assert.deepEqual(await ui.calls('openMicrophonePage'), [['after-call']], 'not installed: its page, tagged with where it came from')
    // Another call's page does not say it.
    await ui.click('.meeting-detail button', 'Back to Meetings')
    await ui.click('.meeting-row', 'Open call: Acme renewal')
    await ui.wait("!!document.querySelector('.meeting-detail .call-detail-tabs')")
    assert.equal(await ui.evaluate("!!document.querySelector('.studio-mention')"), false)
    assert.deepEqual(ui.errors, [])
    ui.window.destroy()
  }
  console.log('Noisy room: one line on the call page after the call, with one link, passed.')
}

/** F8 Show's overlay: drag over a part, draw on it, Save; the picture is that part at the screen's own size. Esc leaves it. */
async function checkShow(T, agent) {
  const ui = await open(T, agent, 'show', 800, 600, 'show')
  await ui.wait("document.querySelector('.show-shot')?.complete===true")
  assert.equal(await ui.evaluate("document.querySelector('.show-bar span').textContent"), 'Drag over the part to show, and talk.')
  const pointer = (type, x, y) => ui.evaluate(`document.querySelector('.show').dispatchEvent(new PointerEvent(${JSON.stringify(type)},{clientX:${x},clientY:${y},button:0,pointerId:1,bubbles:true}))`)
  await pointer('pointerdown', 100, 100)
  await pointer('pointermove', 300, 250)
  await pointer('pointerup', 300, 250)
  await ui.wait("!!document.querySelector('.show-part')")
  assert.deepEqual(await ui.evaluate("(()=>{const s=document.querySelector('.show-part').style;return [s.left,s.top,s.width,s.height]})()"), ['100px', '100px', '200px', '150px'])
  assert.equal(await ui.evaluate("document.querySelector('.show-bar span').textContent"), 'Draw on it while you talk. Save puts the picture and your words in.')
  // Drawn on while talking.
  await pointer('pointerdown', 150, 150)
  await pointer('pointermove', 200, 200)
  await pointer('pointermove', 250, 180)
  await pointer('pointerup', 250, 180)
  assert.equal(await ui.evaluate("document.querySelectorAll('.show-ink polyline').length"), 1)
  await ui.capture('show')
  const scale = await ui.evaluate('1600/innerWidth')
  await ui.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await ui.wait("window.togleUITest.calls().some(call=>call.name==='showDone')")
  const [done] = (await ui.calls('showDone'))[0]
  assert.deepEqual(done.head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG')
  assert.deepEqual([done.width, done.height], [Math.round(200 * scale), Math.round(150 * scale)], "the part chosen, at the screen's own size")
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()

  // A click is not a part: Save then takes the whole screen. Esc leaves it.
  const again = await open(T, agent, 'show', 800, 600, 'show')
  await again.wait("document.querySelector('.show-shot')?.complete===true")
  await again.evaluate("document.querySelector('.show').dispatchEvent(new PointerEvent('pointerdown',{clientX:50,clientY:50,button:0,pointerId:1,bubbles:true}))")
  await again.evaluate("document.querySelector('.show').dispatchEvent(new PointerEvent('pointerup',{clientX:52,clientY:51,button:0,pointerId:1,bubbles:true}))")
  assert.equal(await again.evaluate("!!document.querySelector('.show-part')"), false)
  await again.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  assert.equal((await again.calls('showCancel')).length, 1)
  assert.equal((await again.calls('showDone')).length, 0)
  await again.click('.show-bar button', 'Save')
  await again.wait("window.togleUITest.calls().some(call=>call.name==='showDone')")
  const [whole] = (await again.calls('showDone'))[0]
  assert.deepEqual([whole.width, whole.height], [1600, 1200], 'the whole screen')
  assert.deepEqual(again.errors, [])
  again.window.destroy()
  console.log('Show: a part dragged out and drawn on, saved at the screen\'s own size; a click takes the whole screen; Esc leaves it passed.')
}

/** The first minute, once: talk, sign in with the plan or skip it, what Togle found; what was skipped goes on To-do. */
async function checkFirstMinute(T, agent) {
  // Speech recognition is not on this computer yet: one click gets it, then F9 works.
  const fresh = await open(T, agent, 'first-minute-new', 640)
  await fresh.wait("!!document.querySelector('.first-minute')")
  assert.deepEqual(await fresh.evaluate("[...document.querySelectorAll('.first-step')].map(step=>step.getAttribute('aria-label'))"), ['Talk', 'Sign in with your plan', 'Togle finds the rest'])
  assert.equal(await fresh.evaluate("!!document.querySelector('.todo')"), false, 'the first minute comes before the list')
  await fresh.wait("[...document.querySelectorAll('.first-step button')].some(b=>b.textContent.startsWith('Get speech recognition'))")
  assert.equal(await fresh.evaluate('window.togleUITest.calls().filter(call=>call.name===\'installLocalSpeech\').length'), 0, 'nothing is downloaded unasked')
  await fresh.capture('first-minute-download')
  await fresh.evaluate("[...document.querySelectorAll('.first-step button')].find(b=>b.textContent.startsWith('Get speech recognition')).click()")
  await fresh.wait("document.querySelector('.first-step[aria-label=Talk]').textContent.includes('This works offline')")
  assert.deepEqual(await fresh.calls('installLocalSpeech'), [['parakeet']], 'what English needs on this computer')
  // Skipped: both steps wait on the list.
  await fresh.click('.first-step button', 'Skip')
  await fresh.click('.first-done button', 'Done')
  await fresh.wait("!!document.querySelector('.todo')")
  assert.equal(await fresh.evaluate('window.togleUITest.settings().firstMinute.done'), true)
  assert.deepEqual((await fresh.calls('addTodo')).map(args => args[0]), [
    'Hold F9 and say something: Togle types it where your cursor is',
    'Sign in with your AI plan in Settings, so Togle cleans up what you say and writes your meeting notes'
  ])
  await fresh.wait("document.querySelectorAll('.todo-item').length===2")
  assert.deepEqual(fresh.errors, [])
  fresh.window.destroy()

  // Done in full: nothing is left for the list.
  const ui = await open(T, agent, 'first-minute', 1024)
  await ui.wait("!!document.querySelector('.first-minute')")
  assert.ok((await ui.evaluate("document.querySelector('.first-step[aria-label=Talk]').textContent")).includes('Hold F9 and say something.'))
  await ui.emit('onDictation', { phase: 'done', outcome: 'inserted', lastText: 'Hello from the first minute.' })
  await ui.wait("document.querySelector('.first-step[aria-label=Talk] .first-ok')?.textContent==='It works. Heard: “Hello from the first minute.”'")
  assert.ok((await ui.evaluate("document.querySelector('.first-step[aria-label=\"Sign in with your plan\"]').textContent")).includes('Send it to Marta by Friday.'))
  await ui.click('.first-step button', 'Sign in with ChatGPT')
  await ui.wait("document.querySelector('.first-step[aria-label=\"Sign in with your plan\"] .first-ok')?.textContent.startsWith('Signed in.')")
  assert.deepEqual(await ui.calls('signInAccount'), [['chatgpt-default']])
  assert.ok((await ui.evaluate("document.querySelector('.first-step[aria-label=\"Togle finds the rest\"]').textContent")).includes('No coding agent on this computer yet'))
  assert.equal(await ui.evaluate("document.querySelectorAll('.first-step.done').length"), 2)
  await ui.fitsWidth()
  await ui.capture('first-minute')
  await ui.click('.first-done button', 'Done')
  await ui.wait("!!document.querySelector('.todo')")
  assert.deepEqual(await ui.calls('addTodo'), [], 'nothing left to do from the first minute')
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()
  console.log('First minute: speech recognition on one click, F9 heard, the plan signed in or skipped, what Togle found, and the steps left on To-do passed.')
}

/** Settings on one screen: Keys, Voice, Meetings, Agents, Accounts; the plan or a key instead; Togle Studio. */
async function checkSettings(T, agent) {
  const ui = await open(T, agent, 'settings', 1024)
  await ui.click('.workspace-nav button', 'Settings')
  await ui.wait("!!document.querySelector('#settings-accounts .ai-plan')")
  assert.deepEqual(await texts(ui, '.settings-one section h3'), ['Keys', 'Voice', 'Meetings', 'Agents', 'Accounts'])
  assert.deepEqual(await texts(ui, '#settings-keys .shortcut-what'), ['Talk', 'Show', 'Task'])
  assert.deepEqual(await texts(ui, '#settings-keys button.keys'), ['F9', 'F8', 'F10'])
  const names = await texts(ui, '#settings-voice .setting > .name')
  assert.deepEqual(names.slice(0, 4), ['Microphone', 'Language', 'Names and terms', 'Clean up what I say'])
  assert.equal(await ui.evaluate("document.querySelector('#settings-voice [aria-label=\"Microphone\"]').value"), '', 'the system default')
  assert.equal(await ui.evaluate("document.querySelector('#settings-voice [aria-label=\"Language\"] option[value=auto]').textContent"), 'Detected')
  assert.ok((await ui.evaluate("document.querySelector('#settings-voice').textContent")).includes('Needs your AI plan'), 'cleanup says what it needs while no plan is signed in')
  if (process.platform === 'win32') assert.deepEqual(await texts(ui, '#settings-meetings .setting > .name'), ['Zoom', 'Meet', 'Teams', 'Webex', 'Skype', 'Slack', 'Remembered voices'])
  assert.equal(await ui.evaluate("document.querySelector('#settings-meetings .setting:last-of-type .setting-value')?.textContent"), 'None')
  await ui.capture('settings')

  // Names and terms open where they are, and close again.
  await ui.click('#settings-voice button', 'Change')
  await ui.wait("!!document.querySelector('#settings-voice .vocabulary-editor')")
  await ui.click('#settings-voice button', 'Done')
  // Remembered voices: nobody until it is turned on.
  await ui.click('#settings-meetings button', 'Change')
  await ui.wait("!!document.querySelector('.remembered-people [role=switch]')")
  assert.equal(await ui.evaluate("document.querySelector('.remembered-people [role=switch]').checked"), false)
  await ui.evaluate("document.querySelector('.remembered-people [role=switch]').click()")
  await ui.wait('window.togleUITest.settings().assist.rememberVoices===true')
  if (process.platform === 'win32') {
    await ui.evaluate("(()=>{const select=document.querySelector('[aria-label=\"When a call starts in Zoom\"]');select.value='always';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
    await ui.wait("window.togleUITest.settings().meetings.apps.zoom==='always'")
  }

  // The AI plan: one sign-in, or a key from another service instead.
  assert.equal(await ui.evaluate("document.querySelector('.ai-plan .control button')?.textContent"), 'Sign in with ChatGPT')
  assert.ok((await ui.evaluate("document.querySelector('.ai-plan-other').textContent")).includes('No ChatGPT plan? Use a key from Gemini, Grok, Kimi or any other.'))
  await ui.click('.ai-plan-other button', 'Use a key')
  await ui.wait("!!document.querySelector('form.ai-key-form')")
  assert.deepEqual(await texts(ui, '.ai-key-form [aria-label=Service] option'), ['Gemini', 'Grok', 'Kimi', 'Another service'])
  await ui.fill('.ai-key-form input[aria-label=Key]', 'fictional-gemini-key')
  await ui.click('.ai-key-form button', 'Use this key')
  await ui.wait("document.querySelector('.ai-plan .note')?.textContent==='Gemini · key'")
  const [added] = (await ui.calls('addApiConnection')).map(args => args[0])
  assert.deepEqual({ ...added, key: added.key ? 'given' : 'none' }, { kind: 'compatible', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', key: 'given' })
  const ai = await ui.evaluate('window.togleUITest.settings().ai')
  assert.deepEqual(Object.values(ai.tasks).map(task => task.model), ['local-fixture', 'local-fixture', 'local-fixture', 'local-fixture'], 'every job uses the model the service lists')
  assert.equal(await ui.evaluate('window.togleUITest.settings().provider'), 'compat')
  assert.ok(!(await ui.evaluate("document.querySelector('#settings-voice').textContent")).includes('Needs your AI plan'), 'with a key, cleanup has what it needs')
  await ui.capture('settings-key')
  // Signing in with ChatGPT makes the plan the AI again. (A menu opens only on a button in sight.)
  await ui.evaluate("document.querySelector('.ai-plan').scrollIntoView({ block: 'center' })")
  await ui.paint()
  await ui.click('.ai-plan .control button', 'Manage')
  await ui.click('.menu-item, [role=menuitem]', 'Sign in with ChatGPT instead')
  await ui.wait("document.querySelector('.ai-plan .note')?.textContent.startsWith('ChatGPT · signed in')")
  assert.equal(await ui.evaluate('window.togleUITest.settings().ai'), null)
  assert.equal(await ui.evaluate('window.togleUITest.settings().provider'), 'chatgpt')

  // Togle Studio: where it stands and the one thing to do, and one switch for mentioning it.
  assert.equal(await ui.evaluate("document.querySelector('.studio-row .setting-value').textContent"), 'Not installed')
  await ui.click('.studio-row button', 'See Togle Studio')
  assert.deepEqual(await ui.calls('openMicrophonePage'), [['settings']])
  const mention = "[...document.querySelectorAll('#settings-accounts .setting')].find(row=>row.querySelector('.name')?.textContent==='Mention Togle Studio').querySelector('[role=switch]')"
  assert.equal(await ui.evaluate(mention + '.checked'), true)
  await ui.evaluate(mention + '.click()')
  await ui.wait('window.togleUITest.settings().microphone.suggestions===false')
  for (const width of [640, 420]) {
    ui.window.setSize(width, 800)
    await ui.paint()
    await ui.fitsWidth()
    await ui.capture('settings-' + width)
  }
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()
  console.log('Settings: Keys, Voice, Meetings, Agents and Accounts on one screen, names and terms, remembered voices, a call app, the ChatGPT sign-in and a Gemini key instead, Togle Studio and its mentions, and narrow sizes passed.')
}

/** Meeting notes in Markdown: what it can hold, links that open outside, code to copy, and nothing that loads or runs. */
async function checkRichText(T, agent) {
  const samples = require('./rich-text-fixtures.cjs')
  for (const width of [420, 960]) {
    const ui = await open(T, agent, 'rich-text', width)
    await ui.click('.workspace-nav button', 'Meetings')
    await ui.click('.meeting-row', 'Open call: Acme renewal')
    const md = "document.querySelector('.meeting-detail .call-detail-content .md')"
    const all = selector => '[...' + md + '.querySelectorAll(' + JSON.stringify(selector) + ')]'
    await ui.wait('!!' + md + "?.querySelector('table')")
    assert.equal(await ui.evaluate(md + ".querySelector('h4').textContent"), 'Release review')
    assert.equal(await ui.evaluate(md + ".querySelector('ol').start"), 3)
    assert.deepEqual(await ui.evaluate(all('input[type=checkbox]') + '.map(box=>({checked:box.checked,disabled:box.disabled}))'), [{ checked: true, disabled: true }, { checked: false, disabled: true }])
    assert.equal(await ui.evaluate(all('blockquote') + '.length'), 1)
    assert.equal(await ui.evaluate(all('img,script') + '.length'), 0)
    assert.equal(await ui.evaluate(all('a') + ".some(a=>/javascript:|file:/.test(a.getAttribute('href')))"), false)
    assert.ok(await ui.evaluate(md + ".textContent.includes('Café · 你好 · 한국어')"))
    assert.ok(await ui.evaluate(md + ".textContent.includes('items[0]')&&" + md + ".textContent.includes('[99]')"))
    await ui.evaluate(all('a') + ".find(a=>a.textContent==='SOH-123: OAuth callback').click()")
    assert.equal((await ui.calls('openExternal')).at(-1)[0], 'https://example.com/browse/SOH-123?view=detail&from=meeting')
    await ui.evaluate(all('a') + ".find(a=>a.getAttribute('href').startsWith('mailto:')).click()")
    assert.equal((await ui.calls('openExternal')).at(-1)[0], 'mailto:team@example.com')
    await ui.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__richCopied=text}}})")
    await ui.click('.meeting-detail .code-block button', 'Copy')
    assert.equal(await ui.evaluate('window.__richCopied'), samples.code)
    assert.equal(await ui.evaluate(md + ".querySelector('pre code').textContent"), samples.code)
    assert.ok(await ui.evaluate("[...document.querySelectorAll('.meeting-detail .md,.meeting-detail .md-table,.meeting-detail .code-block')].every(el=>el.getBoundingClientRect().right<=innerWidth-6)"), 'the notes fit the window')
    await ui.fitsWidth()
    await ui.capture('rich-notes-' + width)
    assert.deepEqual(ui.remoteRequests, [], 'notes never load a picture from the web')
    assert.equal(await ui.evaluate('window.__richTextAttack'), undefined)
    assert.deepEqual(ui.errors, [])
    ui.window.destroy()
  }
  console.log('Notes in Markdown: headings, lists, tasks, quotes, a table, links that open outside, exact code copy, and nothing loaded or run at 420 and 960 px passed.')
}

app.whenReady().then(async () => {
  try {
    const T = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
    const store = new T.AgentStore(async () => '')
    await store.load()
    const agent = store.list()[0]
    await checkCall(T, agent)
    await checkFirstCall(T, agent)
    await checkMeetings(T, agent)
    await checkProblems(T, agent)
    await checkNoisyCall(T, agent)
    await checkRichText(T, agent)
    await checkSettings(T, agent)
    await checkFirstMinute(T, agent)
    await checkShow(T, agent)
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error.stack)
    app.exit(1)
  }
})
