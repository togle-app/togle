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
// Empty: Windows reuses process ids, and an earlier run's profile would still hold what its windows kept.
fs.rmSync(data, { recursive: true, force: true })
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
  const fixture = JSON.stringify({ showPicture, settings, names, agents: [agent], scenario, readyAudio: !['speech', 'first-minute-new'].includes(scenario), richText })
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
  // Agents can be connected before the call starts: the call has its key already.
  assert.deepEqual(await texts(ui, '.meetings .call-agents .lab'), ['Agents for the next call'])
  assert.deepEqual(await texts(ui, '.meetings .call-agents button'), ['Add'], 'no one is connected yet: nothing to send')
  await ui.click('.meetings .meetings-top button', 'Write down now')
  await ui.wait('!!' + LIVE)
  assert.deepEqual(await ui.calls('setListening'), [[true]])
  const order = await ui.evaluate("window.togleUITest.calls().map(call=>call.name).filter(name=>['clearTranscript','prepareCallMicrophone','setListening'].includes(name))")
  assert.deepEqual(order, ['clearTranscript', 'prepareCallMicrophone', 'setListening'], 'a new call each time; Togle Studio is asked before the audio opens')
  assert.equal(await ui.evaluate('window.togleUITest.settings().assist.auto'), false, 'nothing is suggested during a call unasked')
  assert.equal(await ui.evaluate("document.querySelector('.titlebar').textContent.trim()"), 'Togle', "the title bar is the window's name, as the design draws it")
  assert.ok(await ui.evaluate("!!document.querySelector('.workspace-nav button[aria-label=\"Meetings\"] .dot.live')"))
  assert.deepEqual(await texts(ui, '.live-sources > span'), ['You', 'Call'])
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.live-head button')].map(b=>b.textContent.trim())"), ['Mark', 'Stop'])

  // The line to tell the others stays until it is ticked, and says where the sound goes.
  assert.equal(await ui.evaluate("document.querySelector('.tell-others .tell-line')?.textContent"), "I'm writing this call down with Togle. The sound stays on my computer.")
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
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.live-people .person-chip')].map(c=>c.classList.contains('ok'))"), [true, true, false, false], 'confirmed ones are green, as the design has them')
  assert.equal(await ui.evaluate("document.querySelector('.live-clock').textContent.startsWith('Live · ')"), true, 'the time in a chip')
  assert.equal(await ui.evaluate("document.querySelectorAll('.live-meter .bars i').length"), 8, 'four bars for you and four for the call')

  // Mark flags the moment: the line just said is marked and stands out.
  await ui.click('.live-head button', 'Mark')
  await ui.wait("document.querySelector('.live-line:last-child .marked-tag')?.textContent==='Marked'")
  assert.equal(await ui.evaluate("document.querySelector('.live-line:last-child').classList.contains('marked')"), true)
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.live-head button')][0].textContent.trim()"), 'Mark', 'Mark stays Mark')
  assert.equal((await ui.calls('markCall')).length, 1)
  await ui.evaluate("document.querySelector('.tell-others .tell-tick input').click()")
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

  // Agents on the call: connect a running agent task, and Send what was said so far to the ticked ones.
  assert.deepEqual(await texts(ui, '.live-call .call-agents .lab'), ['Agents'])
  assert.equal(await ui.evaluate("document.querySelectorAll('.meetings .call-agents').length"), 0, 'the list of calls is not behind the live call')
  await ui.evaluate("window.togleUITest.terminalTask({ key: 'claude:s9', runner: 'claude', title: 'Rebuild the pricing page', folder: 'C:\\\\work\\\\website', state: 'idle', screen: true }, '')")
  await ui.click('.call-agents button', 'Add')
  await ui.wait("document.querySelectorAll('.give-row').length>=1")
  assert.equal(await ui.evaluate("document.querySelector('.give-panel').getAttribute('aria-label')"), 'Add agents to this call')
  assert.equal(await ui.evaluate("!!document.querySelector('.give-words')"), false, 'connecting asks for no words')
  await ui.evaluate("[...document.querySelectorAll('.give-row')].find(r=>r.textContent.includes('Rebuild the pricing page')).querySelector('input').click()")
  await ui.click('.give-panel .primary', 'Done')
  await ui.wait("document.querySelectorAll('.agent-chip').length===1")
  const onCall = (await ui.calls('setCallAgents')).at(-1)
  assert.deepEqual(onCall[1], ['claude:s9'])
  assert.equal(await ui.evaluate("document.querySelector('.agent-chip .cut').textContent"), 'Claude Code · website')
  assert.equal(await ui.evaluate("document.querySelector('.agent-chip input').checked"), true, 'connected, it is ticked: it gets what is said')
  await ui.capture('live-call-agents')
  await ui.click('.call-agents .primary', 'Send what was said')
  await ui.wait("!!document.querySelector('.call-agents-wrap .hint[role=status]')")
  assert.deepEqual((await ui.calls('giveCall')).map(args => args[0]), [{ call: onCall[0], tasks: ['claude:s9'], prompt: '' }], 'only the ticked ones, with no words of its own: it is the call that is sent')
  assert.equal(await ui.evaluate("document.querySelector('.call-agents-wrap .hint[role=status]').textContent"), 'Sent to Rebuild the pricing page (Claude Code).')
  // Ask: a question for the ticked agents, with where the call is saved so far. What they answer shows under the box, with a card if
  // they need an Allow to go on, and the question box is empty again.
  assert.equal(await ui.evaluate("document.querySelector('.call-ask input').placeholder"), 'Ask the agents about this call, or hold F9 and say it')
  assert.equal(await ui.evaluate("document.querySelector('.call-ask button').disabled"), true, 'nothing to ask yet')
  await ui.fill('.call-ask input', 'Did Dario agree to two plans?')
  await ui.click('.call-ask button', 'Ask')
  await ui.wait("!!document.querySelector('.call-answer')")
  assert.deepEqual((await ui.calls('giveCall')).at(-1)[0], { call: onCall[0], tasks: ['claude:s9'], prompt: 'Did Dario agree to two plans?' }, 'the question goes to the ticked agents, with no other words')
  assert.equal(await ui.evaluate("document.querySelector('.call-ask input').value"), '', 'the box is empty once it was asked')
  assert.equal(await ui.evaluate("document.querySelector('.call-answer-head b').textContent"), 'Claude Code · website')
  assert.equal(await ui.evaluate("document.querySelector('.call-answer-question').textContent"), 'You asked: Did Dario agree to two plans?')
  assert.equal(await ui.evaluate("document.querySelector('.call-answer .hint:not(.call-answer-question)').textContent"), 'Working on it…', 'until it has said something')
  await ui.evaluate("window.togleUITest.answerOnCall('claude:s9', 'Did Dario agree to two plans?', 'Yes. At 12:38 Dario asks to ship with two plans first, and nobody objects.')")
  await ui.wait("document.querySelector('.call-answer .task-agent')?.textContent.startsWith('Yes.')")
  assert.equal(await ui.evaluate("document.querySelector('.call-answer .state-chip').textContent"), 'Answered')
  await ui.capture('live-call-answer')
  // It needs to read a file first: its card is there, and Allow once answers the task.
  await ui.evaluate("window.togleUITest.askOutside('claude:s9', { id: 'q9', kind: 'command', command: 'cat notes/pricing.md', raw: 'cat notes/pricing.md', folder: 'C:\\\\work\\\\website', offersAlways: false })")
  await ui.wait("!!document.querySelector('.call-answer .task-request')")
  assert.equal(await ui.evaluate("document.querySelector('.call-answer .task-command').textContent"), 'cat notes/pricing.md')
  await ui.click('.call-answer .task-request button', 'Allow once')
  assert.deepEqual((await ui.calls('answerRunnerTask')).at(-1), ['claude:s9', 'q9', 'allow-once'])
  // A task that took no question: the reason, in words, and the question stays in the box.
  await ui.evaluate("window.togleUITest.giveFails('claude:s9', 'It is working')")
  await ui.fill('.call-ask input', 'And Marta?')
  await ui.click('.call-ask button', 'Ask')
  await ui.wait("!!document.querySelector('.call-agents-wrap .error[role=status]')")
  assert.equal(await ui.evaluate("document.querySelector('.call-agents-wrap .error[role=status]').textContent"), 'Rebuild the pricing page (Claude Code): It is working')
  assert.equal(await ui.evaluate("document.querySelector('.call-ask input').value"), 'And Marta?', 'the question stays when no agent took it')
  await ui.evaluate("window.togleUITest.giveFails('claude:s9', '')")
  await ui.fill('.call-ask input', '')
  // The answer is put away with its mark.
  await ui.click('.call-answer-head button', 'Dismiss this answer')
  await ui.wait("!document.querySelector('.call-answer')")
  await ui.evaluate("document.querySelector('.agent-chip input').click()")
  await ui.wait("document.querySelector('.call-agents .primary').disabled===true")
  await ui.evaluate("document.querySelector('.agent-chip input').click()")
  await ui.click('.agent-chip button', 'Take Rebuild the pricing page off the call')
  await ui.wait("document.querySelectorAll('.agent-chip').length===0")
  assert.deepEqual((await ui.calls('setCallAgents')).at(-1)[1], [], 'taken off the call')
  assert.equal(await ui.evaluate("!!document.querySelector('.call-agents .primary')"), false, 'no one is on the call: nothing to send')

  // From another place, Meetings in the rail (with the call's dot) leads back to the call.
  await ui.click('.workspace-nav button', 'To-do')
  await ui.wait("!!document.querySelector('.todo')")
  await ui.click('.workspace-nav button', 'Meetings')
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
  assert.equal(await ui.evaluate("!!document.querySelector('.workspace-nav .dot.live')"), false, 'the dot goes with the call')
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.meeting-detail [role=tab]')].map(tab=>tab.textContent)"), ['Notes', 'Transcript'])
  await ui.click('.meeting-detail [role=tab]', 'Transcript')
  await ui.wait("[...document.querySelectorAll('.meeting-detail .history-transcript-line')].some(line=>line.textContent.includes('staging logs'))")
  await ui.capture('after-call')
  await ui.click('.workspace-nav button', 'Meetings')
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
  await ui.click('.meetings .meetings-top button', 'Write down now')
  await ui.wait("!!document.querySelector('.first-call')")
  const said = await ui.evaluate("document.querySelector('.first-call').textContent")
  assert.match(said, /rules for writing down a call differ by place/)
  assert.match(said, /The words go to your AI plan, which writes the notes/)
  assert.match(said, /the sound stays on this computer\./)
  await ui.capture('first-call')
  await ui.click('.first-call button', 'Got it')
  await ui.wait("!document.querySelector('.first-call')")
  assert.equal(await ui.evaluate('window.togleUITest.settings().meetings.introSeen'), true)
  await ui.click('.live-head button', 'Stop')
  await ui.wait("!!document.querySelector('.meeting-detail')")
  await ui.click('.workspace-nav button', 'Meetings')
  await ui.click('.meetings .meetings-top button', 'Write down now')
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
  assert.ok((await ui.evaluate(panel)).includes('Who spoke?2 of 3 to confirm'), 'how many of the three people in the call are left')
  assert.deepEqual(await texts(ui, '.confirm-names .person-chip.ok'), ['You'], 'who is confirmed already')
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.confirm-voice')].map(v=>v.classList.contains('guess'))"), [true, false], 'a guess is amber, as everything that waits for you')
  assert.ok((await ui.evaluate(panel)).includes('Dario said “Marta” just before.'))
  assert.ok((await ui.evaluate(panel)).includes('Closes after your last answer. The sound is deleted then, or tomorrow at the latest.'))
  await ui.capture('confirm-names')
  await ui.click('.confirm-names button', 'Play Marta?')
  await ui.wait("window.togleUITest.calls().some(call=>call.name==='confirmSound'&&call.args[1]==='v0')")
  await ui.click('.confirm-names button', 'Yes')
  await ui.wait("document.querySelector('.confirm-names').textContent.includes('1 of 3 to confirm')")
  await ui.click('.confirm-names button', 'Name')
  await ui.fill('.confirm-names input[aria-label="Name for Voice 2"]', 'Ivan')
  await ui.click('.confirm-names button', 'Save')
  await ui.wait("!document.querySelector('.confirm-names')")
  assert.deepEqual((await ui.calls('confirmAnswer')).map(args => args.slice(1)), [['voice:1', 'Marta'], ['voice:2', 'Ivan']], 'the last answer closes it')
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.meeting-detail [role=tab]')].map(tab=>tab.textContent)"), ['Notes', 'Transcript'])
  assert.equal(await ui.evaluate("!!document.querySelector('.meeting-detail .call-detail-head .hint')"), false, 'the page opens on its name and its buttons, as the design has it')
  assert.deepEqual(await texts(ui, '.meeting-detail .call-record-actions > *'), ['Share', 'Give to an agent'], 'Share, then Give to an agent, as the design has them')
  // Its name is renamed with a click on it; a right click on it renames or deletes it.
  await ui.click('.meeting-detail .call-detail-head h2', 'Sprint review')
  await ui.wait("!!document.querySelector('.meeting-detail .rename-title')")
  await ui.fill('.meeting-detail .rename-title', 'Sprint review, week 46')
  await ui.evaluate("document.querySelector('.meeting-detail .rename-title').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await ui.wait("document.querySelector('.meeting-detail .call-detail-head h2')?.textContent==='Sprint review, week 46'")
  assert.deepEqual((await ui.calls('renameCallSession')).map(args => args[1]), ['Sprint review, week 46'])
  await ui.evaluate("document.querySelector('.meeting-detail .call-detail-head h2').dispatchEvent(new MouseEvent('contextmenu',{clientX:200,clientY:80,bubbles:true,cancelable:true}))")
  await ui.wait("!!document.querySelector('.call-menu')")
  assert.deepEqual(await texts(ui, '.call-menu button'), ['Rename', 'Delete call'])
  await ui.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  await ui.wait("!document.querySelector('.call-menu')")
  // Give to an agent lists the agent tasks on this computer to tick (any number), and a new task, with what to do with the call.
  await ui.evaluate("window.togleUITest.terminalTask({ key: 'claude:s9', runner: 'claude', title: 'Rebuild the pricing page', folder: 'C:\\\\work\\\\website', state: 'idle', screen: true, updatedAt: Date.now() + 5000 }, '')")
  await ui.evaluate("window.togleUITest.terminalTask({ key: 'hermes:h1', runner: 'hermes', title: 'Write the release notes', folder: 'C:\\\\work\\\\notes', state: 'working', screen: true }, '')")
  await ui.evaluate("window.togleUITest.terminalTask({ key: 'claude:t1', runner: 'claude', title: 'Check refunds', folder: 'C:\\\\work\\\\website', state: 'working', mine: false, terminal: false }, '')")
  await ui.click('.meeting-detail .call-record-actions button', 'Give to an agent')
  await ui.wait("document.querySelectorAll('.give-row').length===4")
  assert.equal(await ui.evaluate("document.querySelector('.give-panel').getAttribute('aria-label')"), 'Give this call to')
  const rowOf = title => "[...document.querySelectorAll('.give-row')].find(r=>r.textContent.includes(" + JSON.stringify(title) + "))"
  assert.equal(await ui.evaluate(rowOf('Rebuild the pricing page') + ".querySelector('small').textContent"), 'Claude Code · website · done', 'a task that has finished can take the call')
  assert.equal(await ui.evaluate(rowOf('Write the release notes') + ".querySelector('small').textContent"), 'Hermes · It is working', 'one that works cannot: Hermes takes words when its turn has ended')
  assert.equal(await ui.evaluate(rowOf('Write the release notes') + ".querySelector('input').disabled"), true)
  assert.equal(await ui.evaluate(rowOf('Check refunds') + ".querySelector('small').textContent"), 'Claude Code · Open it in Agents first', 'a task Togle does not run is not written to')
  assert.equal(await ui.evaluate("document.querySelector('.give-panel .primary').disabled"), true, 'nothing is ticked: nothing to give')
  await ui.evaluate(rowOf('Rebuild the pricing page') + ".querySelector('input').click()")
  await ui.wait("document.querySelector('.give-panel .primary').textContent==='Give to 1'")
  await ui.fill('.give-words', 'Draft the follow-up email')
  await ui.capture('give-call-list')
  await ui.click('.give-panel .primary', 'Give to 1')
  await ui.wait("!document.querySelector('.give-panel')")
  assert.deepEqual((await ui.calls('giveCall')).map(args => args[0]), [{ call: 'confirm-call', tasks: ['claude:s9'], prompt: 'Draft the follow-up email', connect: true }], 'the running task is given the call, and stays on it')
  assert.equal(await ui.evaluate("document.querySelector('.meeting-detail .hint[role=status]').textContent"), 'Sent to Rebuild the pricing page (Claude Code).')
  // Opened again, the agents already on the call are ticked; a new task needs words, an agent and a folder.
  await ui.click('.meeting-detail .call-record-actions button', 'Give to an agent')
  await ui.wait("document.querySelectorAll('.give-row').length===4")
  assert.equal(await ui.evaluate(rowOf('Rebuild the pricing page') + ".querySelector('input').checked"), true, 'on the call already: ticked')
  await ui.evaluate("[...document.querySelectorAll('.give-row')].find(r=>r.textContent.includes('A new task')).querySelector('input').click()")
  await ui.wait("!!document.querySelector('.give-new')")
  assert.deepEqual(await texts(ui, '.give-new button'), ['Claude Code', 'website'], 'the agent and the folder, as the task box has them')
  assert.equal(await ui.evaluate("document.querySelector('.give-panel .primary').disabled"), true, 'a new task needs words')
  await ui.fill('.give-words', 'Write the notes up for the team')
  await ui.wait("document.querySelector('.give-panel .primary').textContent==='Give to 2'")
  await ui.click('.give-panel .primary', 'Give to 2')
  await ui.wait("!document.querySelector('.give-panel')")
  assert.deepEqual((await ui.calls('giveCall')).at(-1)[0], { call: 'confirm-call', tasks: ['claude:s9'], prompt: 'Write the notes up for the team', connect: true, start: { runner: 'claude', folder: 'C:\\work\\website' } })
  assert.ok((await ui.evaluate("document.querySelector('.meeting-detail .hint[role=status]').textContent")).startsWith('Sent to Rebuild the pricing page (Claude Code), '), 'both were given it')
  // A task that cannot take it says why, and the list stays open.
  await ui.evaluate("window.togleUITest.giveFails('claude:s9', 'It is open in another window.')")
  await ui.click('.meeting-detail .call-record-actions button', 'Give to an agent')
  await ui.wait("document.querySelectorAll('.give-row').length===4")
  await ui.fill('.give-words', 'Try again')
  // The agents on the call are ticked, but not the one the call started that is gone from the list: only the task that is there is given it, and it cannot take it.
  await ui.click('.give-panel .primary', 'Give to 1')
  await ui.wait("!!document.querySelector('.give-panel .error')")
  assert.ok((await ui.evaluate("document.querySelector('.give-panel .error').textContent")).includes('Rebuild the pricing page (Claude Code): It is open in another window.'), 'it says which task could not take it, and why')
  await ui.click('.give-panel button', 'Cancel')
  await ui.wait("!document.querySelector('.give-panel')")
  await ui.click('.workspace-nav button', 'Meetings')
  // A right click on a call in the list: rename it, or delete it after asking.
  await ui.evaluate("[...document.querySelectorAll('.meeting-row')].find(row=>row.textContent.includes('Acme renewal')).dispatchEvent(new MouseEvent('contextmenu',{clientX:300,clientY:160,bubbles:true,cancelable:true}))")
  await ui.wait("!!document.querySelector('.call-menu')")
  await ui.click('.call-menu button', 'Delete call')
  await ui.wait("!!document.querySelector('.meetings .notice.ask')")
  assert.ok((await ui.evaluate("document.querySelector('.meetings .notice.ask').textContent")).includes('This can’t be undone.'))
  await ui.click('.meetings .notice.ask button', 'Keep call')
  assert.deepEqual(await ui.calls('deleteCallSession'), [], 'nothing is deleted unless asked twice')
  await ui.click('.meeting-row', 'Open call: Design check')
  await ui.wait("!!document.querySelector('.confirm-names')")
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.confirm-names button')].some(b=>b.textContent.startsWith('Skip'))"), false, 'it closes after the last answer, or by itself the next day')

  // The notes, as the design has them: alone, then a line that your own items are offered on your list.
  await ui.click('.workspace-nav button', 'Meetings')
  await ui.click('.meeting-row', 'Open call: Acme renewal')
  await ui.wait("!!document.querySelector('.meeting-notes .notes-text')")
  assert.equal(await ui.evaluate("!!document.querySelector('.notes-by')"), false, 'notes from before it was kept say nothing about what wrote them')
  assert.equal(await ui.evaluate("document.querySelector('.notes-foot').textContent"), 'Your own items are offered on your to-do list.')
  assert.equal(await ui.evaluate("!!document.querySelector('.meeting-notes button, .personal-call-notes, .meeting-notes-generate')"), false, 'no buttons and no notes of your own under them')

  // While a call is written down, Meetings is the call, and its list waits behind it.
  await ui.click('.workspace-nav button', 'Meetings')
  await ui.click('.meetings .meetings-top button', 'Write down now')
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
  console.log('Meetings: rows with what is left, search, who spoke with a guess, a name, the call page and giving it to an agent, and a call written down from there passed.')
}

/** No coding agent on this computer: Agents names the ones Togle knows, with the line that installs each, to copy. */
async function checkNoAgents(T, agent) {
  const ui = await open(T, agent, 'settings', 1024)
  await ui.click('.workspace-nav button', 'Agents')
  await ui.wait("document.querySelectorAll('.no-agents-row').length===3")
  assert.deepEqual(await texts(ui, '.no-agents-name strong'), ['Claude Code', 'Codex', 'Hermes'])
  const windows = process.platform === 'win32'
  assert.deepEqual(await texts(ui, '.no-agents-line code'), windows
    ? ['irm https://claude.ai/install.ps1 | iex', 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)']
    : ['curl -fsSL https://claude.ai/install.sh | bash', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'], 'the line for this system')
  assert.ok((await ui.evaluate("document.querySelector('.no-agents p').textContent")).includes(windows ? 'Paste one line into PowerShell' : 'Paste one line into a terminal'))
  assert.equal(await ui.evaluate("document.querySelector('.tasks-head .primary').disabled"), true, 'no task can start without an agent')
  // The computer's own clipboard is left alone: the page's is a stand-in here.
  await ui.evaluate("Object.defineProperty(navigator.clipboard,'writeText',{value:async text=>{window.__copied=text}})")
  await ui.evaluate("[...document.querySelectorAll('.no-agents-row')][1].querySelector('button.small').click()")
  await ui.wait("[...document.querySelectorAll('.no-agents-row')][1].querySelector('button.small').textContent==='Copied'")
  assert.equal(await ui.evaluate('window.__copied'), windows ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' : 'curl -fsSL https://chatgpt.com/codex/install.sh | sh')
  await ui.evaluate("[...document.querySelectorAll('.no-agents-row')][2].querySelector('button.link').click()")
  assert.deepEqual(await ui.calls('openExternal'), [['https://github.com/NousResearch/hermes-agent']])
  for (const width of [1024, 420]) {
    ui.window.setSize(width, 800)
    await ui.paint()
    await ui.fitsWidth()
  }
  await ui.capture('agents-none')
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()
  console.log('Agents with none installed: the three Togle knows, the line that installs each on this system, Copy and their pages passed.')
}

/** What can go wrong at the start of a call: no speech recognition yet, a microphone not allowed, a start that fails. */
async function checkProblems(T, agent) {
  // Without speech recognition on this computer, Write down now leads to where it is set up.
  const setup = await open(T, agent, 'speech', 640)
  await setup.click('.workspace-nav button', 'Meetings')
  await setup.click('.meetings .meetings-top button', 'Write down now')
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
  await audio.click('.meetings .meetings-top button', 'Write down now')
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
  await failed.click('.meetings .meetings-top button', 'Write down now')
  await failed.wait("[...document.querySelectorAll('.notice')].some(e=>e.textContent.includes('Call service could not start'))")
  assert.equal(await failed.evaluate(LIVE), null)
  assert.ok(await failed.evaluate("window.audioFixture.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))"))
  await failed.click('.meetings .meetings-top button', 'Write down now')
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
    await ui.click('.meetings .meetings-top button', 'Write down now')
    await ui.wait('!!' + LIVE)
    assert.equal(await ui.evaluate("!!document.querySelector('.studio-mention')"), false, 'nothing about Togle Studio during a call')
    await ui.click('.live-head button', 'Stop')
    // One line on the call's page, with one button, as the design has it.
    await ui.wait("!!document.querySelector('.meeting-detail .studio-mention')")
    assert.equal(await ui.evaluate("document.querySelector('.studio-mention > span').textContent"), 'Your microphone picked up room noise for 3 of 10 minutes.')
    assert.equal(await ui.evaluate("document.querySelector('.studio-mention button').textContent"), 'Clean my microphone')
    assert.equal(await ui.evaluate("document.querySelectorAll('.studio-mention button').length"), 1)
    assert.equal((await ui.calls('noiseMeasured'))[0][0].sample, undefined, 'the audio stays in the window: main gets levels only')
    await ui.fitsWidth()
    await ui.capture('noisy-call-' + width)
    await ui.click('.studio-mention button', 'Clean my microphone')
    assert.deepEqual(await ui.calls('openMicrophonePage'), [['after-call']], 'not installed: its page, tagged with where it came from')
    // Another call's page does not say it.
    await ui.click('.workspace-nav button', 'Meetings')
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
  assert.equal(await ui.evaluate("!!document.querySelector('.show-bar, .show button')"), false, 'no bar and no buttons: Enter puts it in, Esc leaves it')
  const pointer = (type, x, y) => ui.evaluate(`document.querySelector('.show').dispatchEvent(new PointerEvent(${JSON.stringify(type)},{clientX:${x},clientY:${y},button:0,pointerId:1,bubbles:true}))`)
  await pointer('pointerdown', 100, 100)
  await pointer('pointermove', 300, 250)
  await pointer('pointerup', 300, 250)
  await ui.wait("!!document.querySelector('.show-part')")
  assert.deepEqual(await ui.evaluate("(()=>{const s=document.querySelector('.show-part').style;return [s.left,s.top,s.width,s.height]})()"), ['100px', '100px', '200px', '150px'])
  // Drawn on while talking: a bent line stays as drawn, a loop round something is a box, a straight stroke an arrow.
  const stroke = async points => { await pointer('pointerdown', ...points[0]); for (const point of points.slice(1)) await pointer('pointermove', ...point); await pointer('pointerup', ...points.at(-1)) }
  await stroke([[150, 150], [200, 200], [250, 180]])
  assert.equal(await ui.evaluate("document.querySelectorAll('.show-ink polyline').length"), 1)
  await stroke([[160, 160], [240, 158], [242, 210], [162, 212], [158, 166]])
  assert.deepEqual(await ui.evaluate("(()=>{const r=document.querySelector('.show-ink rect');return r&&[r.getAttribute('x'),r.getAttribute('y'),r.getAttribute('width'),r.getAttribute('height')]})()"), ['158', '158', '84', '54'])
  await stroke([[120, 240], [160, 220], [200, 200]])
  assert.equal(await ui.evaluate("document.querySelectorAll('.show-ink path').length"), 1, 'an arrow')
  // A click on the part, then words typed there.
  await pointer('pointerdown', 210, 235)
  await pointer('pointerup', 210, 235)
  for (const key of 'too small') await ui.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}))`)
  assert.equal(await ui.evaluate("document.querySelector('.show-typing')?.textContent"), 'too small')
  assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.show-part')).borderTopStyle"), 'dashed', 'the part in a dashed frame')
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
  await again.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
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
  await ui.wait("document.querySelector('.first-step[aria-label=Talk] .first-heard')?.textContent==='Hello from the first minute.'")
  assert.ok((await ui.evaluate("document.querySelector('.first-step[aria-label=Talk] .first-mini').textContent")).startsWith('Microphone allowedHold F9 and say something.'), 'the design\'s picture: the microphone ticked, the line, the words')
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
  assert.equal(await ui.evaluate("!!document.querySelector('.settings .card-note, .settings .setting > .note')"), false, 'no notes under the rows: everything fits on one screen')
  if (process.platform === 'win32') assert.deepEqual(await texts(ui, '#settings-meetings .setting > .name'), ['Zoom, Meet, Teams', 'Remembered voices'], 'the call apps the design names, together while Togle does the same in each')
  assert.equal(await ui.evaluate("document.querySelector('#settings-meetings .setting:last-of-type .value-button')?.textContent"), 'None')
  assert.ok(await ui.evaluate("(()=>{const s=document.querySelector('.sets');return s.scrollHeight<=innerHeight})()"), 'the groups fit on one screen')
  await ui.capture('settings')

  // Names and terms open where they are, and close again.
  const valueOf = (group, name) => "[...document.querySelectorAll('" + group + " .setting')].find(r=>r.querySelector('.name')?.textContent===" + JSON.stringify(name) + ").querySelector('.value-button')"
  await ui.evaluate(valueOf('#settings-voice', 'Names and terms') + '.click()')
  await ui.wait("!!document.querySelector('#settings-voice .vocabulary-editor')")
  await ui.click('#settings-voice button', 'Done')
  // Remembered voices: nobody until it is turned on.
  await ui.evaluate(valueOf('#settings-meetings', 'Remembered voices') + '.click()')
  await ui.wait("!!document.querySelector('.remembered-people [role=switch]')")
  assert.equal(await ui.evaluate("document.querySelector('.remembered-people [role=switch]').checked"), false)
  await ui.evaluate("document.querySelector('.remembered-people [role=switch]').click()")
  await ui.wait('window.togleUITest.settings().assist.rememberVoices===true')
  if (process.platform === 'win32') {
    await ui.evaluate("(()=>{const select=document.querySelector('[aria-label=\"When a call starts in Zoom, Meet, Teams\"]');select.value='always';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
    await ui.wait("window.togleUITest.settings().meetings.apps.zoom==='always'")
  }

  // The AI plan: one sign-in, or a key from another service instead.
  assert.equal(await ui.evaluate("document.querySelector('.ai-plan .control button')?.textContent"), 'Sign in with ChatGPT')
  assert.ok((await ui.evaluate("document.querySelector('.ai-plan-other').textContent")).includes('No ChatGPT plan? Use a key from Claude, Gemini, Grok, Kimi or any other.'))
  await ui.click('.ai-plan-other button', 'Use a key')
  await ui.wait("!!document.querySelector('form.ai-key-form')")
  assert.deepEqual(await texts(ui, '.ai-key-form [aria-label=Service] option'), ['Claude', 'Gemini', 'Grok', 'Kimi', 'Another service'])
  assert.equal(await ui.evaluate("document.querySelector('.ai-key-form [aria-label=Service]').value"), 'claude', 'Claude first: there is no Claude sign-in, so a key from Anthropic is how Claude is used')
  await ui.fill('.ai-key-form input[aria-label=Key]', 'fictional-claude-key')
  await ui.click('.ai-key-form button', 'Use this key')
  await ui.wait("document.querySelector('.ai-plan .control button')?.textContent==='Claude · key'")
  const [added] = (await ui.calls('addApiConnection')).map(args => args[0])
  assert.deepEqual({ ...added, key: added.key ? 'given' : 'none' }, { kind: 'anthropic', label: 'Claude', baseUrl: '', model: '', key: 'given' }, "Anthropic's own API: no address to give")
  const ai = await ui.evaluate('window.togleUITest.settings().ai')
  assert.deepEqual(Object.values(ai.tasks).map(task => task.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5'], 'every job uses one model of the service, the quick and cheap one: Haiku for Claude')
  assert.equal(await ui.evaluate('window.togleUITest.settings().provider'), 'compat')
  await ui.capture('settings-key')
  // Another service's key replaces it: Gemini, at its own OpenAI-compatible address.
  await ui.evaluate("document.querySelector('.ai-plan').scrollIntoView({ block: 'center' })")
  await ui.paint()
  await ui.click('.ai-plan .control button', 'Manage the AI key')
  await ui.click('.menu-item, [role=menuitem]', 'Use a different key')
  await ui.wait("!!document.querySelector('form.ai-key-form')")
  await ui.evaluate("(()=>{const select=document.querySelector('.ai-key-form [aria-label=Service]');select.value='gemini';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await ui.fill('.ai-key-form input[aria-label=Key]', 'fictional-gemini-key')
  await ui.click('.ai-key-form button', 'Use this key')
  await ui.wait("document.querySelector('.ai-plan .control button')?.textContent==='Gemini · key'")
  const keys = (await ui.calls('addApiConnection')).map(args => args[0])
  assert.deepEqual({ ...keys.at(-1), key: keys.at(-1).key ? 'given' : 'none' }, { kind: 'compatible', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', key: 'given' })
  assert.equal((await ui.calls('removeApiConnection')).length, 1, 'the Claude key it replaced is forgotten')
  // Signing in with ChatGPT makes the plan the AI again. (A menu opens only on a button in sight.)
  await ui.evaluate("document.querySelector('.ai-plan').scrollIntoView({ block: 'center' })")
  await ui.paint()
  await ui.click('.ai-plan .control button', 'Manage the AI key')
  await ui.click('.menu-item, [role=menuitem]', 'Sign in with ChatGPT instead')
  await ui.wait("document.querySelector('.ai-plan .control button')?.textContent.startsWith('ChatGPT · signed in')")
  assert.equal(await ui.evaluate('window.togleUITest.settings().ai'), null)
  assert.equal(await ui.evaluate('window.togleUITest.settings().provider'), 'chatgpt')

  // Togle Studio: where it stands and the one thing to do, and one switch for mentioning it.
  assert.equal(await ui.evaluate("!!document.querySelector('.studio-row .setting-value')"), false, 'not installed: only its one button')
  await ui.click('.studio-row button', 'See Togle Studio')
  assert.deepEqual(await ui.calls('openMicrophonePage'), [['settings']])
  // Installed and not running: its state in words, and Open starts it. When it cannot be started, the row says why, not nothing.
  const opened = (await ui.calls('showMicrophone')).length
  await ui.evaluate("window.togleUITest.microphone({ installed: true, running: false })")
  await ui.wait("document.querySelector('.studio-row .setting-value')?.textContent==='Installed · not running'")
  const cannot = "Togle couldn't start Togle Studio. Open it from your apps, then try again."
  await ui.evaluate(`window.togleUITest.failNextShowMicrophone(${JSON.stringify(cannot)})`)
  await ui.click('.studio-row button', 'Open')
  await ui.wait("!!document.querySelector('.studio-row + .error')")
  assert.equal(await ui.evaluate("document.querySelector('.studio-row + .error').textContent"), cannot, 'the reason, without the name of the call it came through')
  assert.equal(await ui.evaluate("document.querySelector('.studio-row + .error').getAttribute('role')"), 'alert')
  assert.equal(await ui.evaluate("document.querySelector('.studio-row button').textContent"), 'Open', 'the button is back')
  await ui.click('.studio-row button', 'Open')
  await ui.wait("!document.querySelector('.studio-row + .error')")
  assert.equal((await ui.calls('showMicrophone')).length - opened, 2, 'Open asked twice; the second one worked and the line went')
  // Gone again (the program was removed): only its one button.
  await ui.evaluate("window.togleUITest.microphone({ installed: false, running: false })")
  await ui.wait("!document.querySelector('.studio-row .setting-value')")
  const mention ="[...document.querySelectorAll('#settings-accounts .setting')].find(row=>row.querySelector('.name')?.textContent==='Mention Togle Studio').querySelector('[role=switch]')"
  assert.equal(await ui.evaluate(mention + '.checked'), true)
  await ui.evaluate(mention + '.click()')
  await ui.wait('window.togleUITest.settings().microphone.suggestions===false')

  // Agents: one that speaks ACP is added by its name and its command, and removed again.
  await ui.evaluate("document.querySelector('#settings-agents').scrollIntoView({ block: 'center' })")
  assert.deepEqual(await texts(ui, '#settings-agents .add-row button'), ['Add an agent'])
  await ui.click('#settings-agents button', 'Add an agent')
  await ui.wait("!!document.querySelector('form.add-agent')")
  await ui.fill('form.add-agent input[aria-label="Agent name"]', 'Gemini CLI')
  await ui.fill('form.add-agent input[aria-label=Command]', 'gemini --acp')
  await ui.capture('settings-add-agent')
  await ui.click('form.add-agent button', 'Add')
  await ui.wait("[...document.querySelectorAll('#settings-agents .agent-label')].some(name=>name.textContent==='Gemini CLI')")
  assert.deepEqual(await ui.calls('addCodingAgent'), [['Gemini CLI', 'gemini --acp']], 'a name and a command: how it runs is not asked')
  assert.equal(await ui.evaluate("!!document.querySelector('form.add-agent [role=radio], form.add-agent .segmented')"), false, 'no choice of how it runs')
  assert.equal(await ui.evaluate("[...document.querySelectorAll('#settings-agents .setting')].find(row=>row.querySelector('.agent-label')?.textContent==='Gemini CLI').querySelector('.setting-value').textContent"), 'Added · conversation', 'a command for ACP opens as a conversation')
  await ui.click('#settings-agents button', 'Remove Gemini CLI')
  await ui.wait("![...document.querySelectorAll('#settings-agents .agent-label')].some(name=>name.textContent==='Gemini CLI')")
  assert.deepEqual(await ui.calls('removeCodingAgent'), [['acp-gemini-cli']])
  // Any other command runs in a terminal of Togle's own: the form says how its words get to it, and how an ACP one is told.
  await ui.click('#settings-agents button', 'Add an agent')
  await ui.wait("!!document.querySelector('form.add-agent')")
  const note = await ui.evaluate("document.querySelector('form.add-agent').textContent")
  assert.ok(note.includes('Togle runs it in a terminal of its own, where you see it and answer it. {task} stands for the task\'s words.'), 'how its words get to it')
  assert.ok(note.includes('A command for ACP, such as gemini --experimental-acp, is talked to directly'), 'and when it is not a terminal')
  await ui.fill('form.add-agent input[aria-label="Agent name"]', 'Aider')
  await ui.fill('form.add-agent input[aria-label=Command]', 'aider --message {task}')
  await ui.capture('settings-add-terminal-agent')
  await ui.click('form.add-agent button', 'Add')
  await ui.wait("[...document.querySelectorAll('#settings-agents .agent-label')].some(name=>name.textContent==='Aider')")
  assert.deepEqual((await ui.calls('addCodingAgent')).at(-1), ['Aider', 'aider --message {task}'])
  assert.equal(await ui.evaluate("[...document.querySelectorAll('#settings-agents .setting')].find(row=>row.querySelector('.agent-label')?.textContent==='Aider').querySelector('.setting-value').textContent"), 'Added · terminal', 'any other command opens as a terminal, and the row says so')
  await ui.click('#settings-agents button', 'Remove Aider')
  await ui.wait("![...document.querySelectorAll('#settings-agents .agent-label')].some(name=>name.textContent==='Aider')")
  assert.deepEqual((await ui.calls('removeCodingAgent')).at(-1), ['term-aider'])
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
    await checkNoAgents(T, agent)
    await checkFirstMinute(T, agent)
    await checkShow(T, agent)
    clearTimeout(timeout)
    app.exit(0)
  } catch (error) {
    console.error(error.stack)
    app.exit(1)
  }
})
