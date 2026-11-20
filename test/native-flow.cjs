// Exercise the actual Electron main process, real IPC handlers, OS encryption, and production renderer.
// The profile is empty; no real account, device, or model is used. Transcript input uses the existing dev hook.
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
app.disableHardwareAcceleration()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const profile = path.join(__dirname, '.work', 'native-' + process.pid)
// Empty: Windows reuses process ids, and an earlier run's profile would still hold its settings and calls.
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
process.env.TOGLE_HEADLESS = '1'
process.env.TOGLE_SILENT_AUDIO = '1'
delete process.env.TOGLE_AUTOSTART
process.env.TOGLE_DEBUG_PORT = '0'
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
process.env.TOGLE_SPEECH_SEEDS = ''
process.env.CLAUDE_CONFIG_DIR = path.join(profile, 'claude')
process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const handlers = new Map()
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => { handlers.set(channel, callback); return originalHandle(channel, callback) }
const invoke = (channel, ...args) => handlers.get(channel)({}, ...args)
let checkpoint = 'startup'
const timeout = setTimeout(() => { console.error('Native checks timed out at ' + checkpoint); app.exit(1) }, 30000)
const wait = async (check, label) => {
  checkpoint = label
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Native app did not reach ' + label)
}
const startup = performance.now()
require('../out/main/index.js')

// An archived call whose account was removed. Both connections terminate in this test process.
async function checkNotesRecovery(evaluate) {
  const posts = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    const evidence = JSON.parse(input.messages.at(-1).content)
    const note = Array.isArray(evidence.confirmed_speakers)
    if (note) posts.push({ path: req.url, model: input.model, names: evidence.confirmed_speakers.map(person => person.name) })
    const content = note ? '## Decisions\n- Keep the release date. [0:00]' : '{"title":"Release review"}'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const connection = label => invoke('connections:add', { kind: 'local', label, baseUrl: 'http://127.0.0.1:' + server.address().port + '/' + label + '/v1', model: '' })
    const profileFor = id => ({ tasks: Object.fromEntries(['quick', 'deep', 'vision', 'background'].map(lane => [lane, { sourceId: id, model: 'model-' + lane, effort: 'low' }])) })
    const old = await connection('Original'), replacement = await connection('Replacement')
    await invoke('settings:update', { ai: profileFor(old.id), assist: { autoNotes: false, rememberCalls: true } })
    const live = await invoke('session:listening', true)
    invoke('dev:transcript', 'me', 'We should keep the release date.')
    invoke('dev:transcript', 'them', 'I agree.', 'restore-piece', 'voice:remote', 2)
    await invoke('session:listening', false)
    await invoke('calls:rename', live.id, 'Account recovery test')
    const draft = await invoke('calls:notes-generate', live.id, 'concise')
    assert.equal(draft.minutes.state, 'ready')
    await invoke('session:clear')
    await invoke('settings:update', { ai: profileFor(replacement.id), assist: { autoNotes: true } })
    await invoke('connections:remove', old.id)
    const named = await invoke('calls:speaker', live.id, 'me', 'Luka')
    const waiting = named.confirm && !named.confirm.closed && named.confirm.voices.some(voice => voice.id === 'voice:remote' && voice.answered === undefined)
    await invoke(waiting ? 'confirm:answer' : 'calls:speaker', live.id, 'voice:remote', 'Angell')
    await wait(async () => (await invoke('calls:get', live.id)).minutes?.state === 'error', 'unavailable saved notes account')
    const failed = await invoke('calls:get', live.id)
    assert.equal(failed.summary, draft.summary)
    assert.match(failed.minutes.error, /account saved for these meeting notes/)
    assert.equal(posts.length, 1, 'choosing a new default did not send the saved meeting there')
    const jsId = JSON.stringify(live.id)
    await evaluate("document.querySelector('.workspace-nav button[aria-label=\"Meetings\"]').click()")
    await wait(() => evaluate("!!document.querySelector('.meeting-row[data-call-id='+CSS.escape(" + jsId + ")+']')"), 'archived meeting in the list')
    await evaluate("document.querySelector('.meeting-row[data-call-id='+CSS.escape(" + jsId + ")+']').click()")
    await wait(() => evaluate("!!document.querySelector('.notes-recovery button')"), 'recovery action in the real meeting window')
    const action = await evaluate("document.querySelector('.notes-recovery button').textContent")
    assert.ok(['Update notes with Replacement', 'Update notes with…'].includes(action), action)
    await evaluate("document.querySelector('.notes-recovery button').click()")
    if (action.endsWith('…')) {
      await wait(() => evaluate("[...document.querySelectorAll('.menu-overlay [role=menuitem]')].some(b=>b.textContent==='Replacement')"), 'replacement choice')
      await evaluate("[...document.querySelectorAll('.menu-overlay [role=menuitem]')].find(b=>b.textContent==='Replacement').click()")
    }
    await wait(async () => (await invoke('calls:get', live.id)).minutes?.state === 'ready', 'real notes retry')
    const saved = await invoke('calls:get', live.id)
    assert.equal(saved.ai.tasks.background.sourceId, old.id)
    assert.equal(saved.minutes.sourceId, replacement.id)
    assert.deepEqual(posts[1], { path: '/Replacement/v1/chat/completions', model: 'model-background', names: ['Luka', 'Angell'] })
    await evaluate("document.querySelector('.meeting-navigation .meeting-remove').click()")
    await wait(() => evaluate("!!document.querySelector('.call-confirm .stop')"), 'visible meeting removal')
    await evaluate("document.querySelector('.call-confirm .stop').click()")
    await wait(async () => (await invoke('calls:get', live.id)) === null, 'confirmed removal from encrypted history')
    console.log('Native meeting recovery: saved names, explicit replacement, configured background model, and removal through the real window passed.')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

async function run() {
  await wait(() => handlers.has('dev:transcript') && BrowserWindow.getAllWindows().length, 'registered IPC')
  const window = BrowserWindow.getAllWindows().find(window => window.getTitle() !== 'Togle voice bar')
  const evaluate = code => window.webContents.executeJavaScript(code)
  await wait(() => evaluate("!!window.togle&&!!document.querySelector('.workspace-nav')"), 'renderer ready')
  console.log(`Isolated native startup: ${Math.round(performance.now() - startup)} ms from loading main to renderer ready.`)
  assert.equal(window.isVisible(), false, 'native tests must not open a user-facing window')
  const microphoneDefaults = invoke('settings:get').microphone
  assert.deepEqual(microphoneDefaults, { suggestions: true, autoStart: true })
  await invoke('settings:update', { microphone: { suggestions: 'no', autoStart: 0, suggestedAt: -1, dismissals: 'many', unknown: true } })
  assert.deepEqual(invoke('settings:get').microphone, microphoneDefaults, 'malformed patches cannot change the Togle Studio settings')
  assert.deepEqual(await invoke('microphone:status'), { installed: false, running: false }, 'a test run never looks at the real Togle Studio')
  const httpRequests = []
  const modelServer = http.createServer((request, response) => { httpRequests.push({ path: request.url, authorization: request.headers.authorization }); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'native-fixture-model' }] })) })
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  try {
    const before = invoke('settings:get')
    const connection = await invoke('connections:add', { kind: 'compatible', label: 'Native API fixture', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, model: '', key: 'fictional-native-key' })
    assert.equal(connection.hasKey, true); assert.equal('key' in connection, false)
    const encryptedKey = fs.readFileSync(path.join(profile, 'connections', connection.id.slice('connection:'.length), 'key.bin'))
    assert.ok(!encryptedKey.includes(Buffer.from('fictional-native-key')), 'the OS encrypts connection keys on disk')
    assert.deepEqual((await invoke('models:list', connection.id)).map(model => model.id), ['native-fixture-model'])
    assert.deepEqual(httpRequests, [{ path: '/v1/models', authorization: 'Bearer fictional-native-key' }])
    assert.equal(invoke('settings:get').provider, before.provider, 'adding a connection does not choose it as the default')
    await invoke('connections:remove', connection.id)
    assert.ok(!fs.existsSync(path.join(profile, 'connections', connection.id.slice('connection:'.length), 'key.bin')))
  } finally { await new Promise(resolve => modelServer.close(resolve)) }
  const speechStatus = invoke('stt:status')
  assert.equal(speechStatus.transcriptionAccount, undefined, 'no account hears calls: this PC does')
  assert.deepEqual([invoke('settings:get').transcription.me, invoke('settings:get').transcription.them], ['local', 'local'])
  // Claude speech was removed (it isn't open to other apps): asking for it gets this PC.
  await invoke('settings:update', { transcription: { accountId: 'claude-default', me: 'claude', them: 'claude', language: 'de' } })
  assert.equal('accountId' in invoke('settings:get').transcription, false, 'calls have no account: voice typing has its own')
  assert.deepEqual([invoke('settings:get').transcription.me, invoke('settings:get').transcription.them], ['local', 'local'])
  assert.equal(invoke('stt:status').transcriptionAccount, undefined)
  assert.equal(invoke('stt:status').transcriptionLanguage, 'de')
  await assert.rejects(Promise.resolve().then(() => invoke('settings:update', { dictation: { accountId: 'missing-speech-profile' } })), /unavailable/)
  await invoke('settings:update', { transcription: { me: 'local', them: 'local', language: 'auto' }, dictation: { accountId: '' } })
  if (process.platform === 'darwin') {
    const menu = Menu.getApplicationMenu()
    assert.ok(menu, 'macOS must have a native application menu')
    const edit = menu.getMenuItemById('togle-edit')?.submenu
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']) {
      assert.ok(edit?.items.some(item => item.role?.toLowerCase() === role), 'The macOS Edit menu must provide ' + role)
    }
  }
  const agentId = invoke('settings:get').activeAgentId
  assert.ok(agentId, 'calls belong to the agent Togle starts with')
  await invoke('settings:update', { assist: { auto: false, autoNotes: false } })
  // The call's language is pinned for the whole call.
  await invoke('settings:update', { transcription: { language: 'de' } })
  const initial = invoke('call:current')
  const live = await invoke('session:listening', true)
  assert.equal(live.id, initial.key)
  assert.equal(live.agentId, agentId)
  await invoke('settings:update', { transcription: { language: 'en' } })
  assert.equal(invoke('stt:status').transcriptionLanguage, 'de', 'an ongoing call retains its original language configuration')
  await invoke('settings:update', { transcription: { me: 'local', them: 'local', language: 'auto' }, dictation: { accountId: '' } })
  assert.ok((await invoke('calls:list')).some(call => call.id === live.id && call.lines === 0), 'history exists before any summary or transcript')
  const simultaneous = await Promise.all(Array.from({ length: 8 }, () => invoke('calls:list')))
  assert.ok(simultaneous.every(list => list.some(call => call.id === live.id && call.lines === 0)), 'concurrent history consumers must receive a complete snapshot')
  await assert.rejects(invoke('calls:delete', live.id), /End the call/)
  invoke('dev:transcript', 'them', 'Can you send the SOC2 report?', 'native-first', 'native:1')
  invoke('dev:transcript', 'me', 'I will send it by Tuesday.')
  assert.equal((await invoke('voices:rename', 'native:1', 'Diana')).state, 'off', 'no voice is remembered until the person turns it on')
  await invoke('settings:update', { assist: { rememberVoices: true } })
  assert.equal((await invoke('voices:rename', 'native:1', 'Diana')).state, 'unavailable', 'text-only fixtures cannot invent a voice profile')
  invoke('dev:transcript', 'them', 'I also need the appendix.', 'native-duplicate', 'native:2')
  await invoke('voices:merge', 'native:2', 'native:1')
  invoke('dev:transcript', 'them', 'Thanks for confirming.', 'native-late', 'native:2')
  assert.ok(invoke('call:current').transcript.filter(line => line.speaker === 'them').every(line => line.voiceId === 'native:1' && line.voiceName === 'Diana'))
  await assert.rejects(invoke('voices:merge', 'native:1', 'me'), /different speakers/)
  invoke('dev:transcript', 'them', 'Please include the date.', 'native-third', 'native:3', 3)
  invoke('dev:transcript', 'them', 'That is everything.', 'native-fourth', 'native:4', 3)
  await invoke('session:listening', false)
  let record = await invoke('calls:get', live.id)
  assert.equal(record.transcript.length, 6)
  assert.equal(record.status, 'ended')
  record = await invoke('calls:speaker', live.id, 'me', 'Luka')
  assert.equal(record.transcript.find(line => line.speaker === 'me').voiceName, 'Luka')
  assert.equal(invoke('call:current').transcript.find(line => line.speaker === 'me').voiceNamedBy, 'user')
  await assert.rejects(invoke('calls:speaker', live.id, 'unknown-voice', 'Someone'), /speaker/)
  // After the call, the voice nobody named is asked about; the sound is the only thing kept, and none was heard here.
  await wait(async () => (await invoke('calls:get', live.id)).confirm, 'the voices to confirm')
  record = await invoke('calls:get', live.id)
  assert.deepEqual(record.confirm.voices.map(voice => [voice.id, voice.guess, voice.clip, voice.answered]), [['native:3', undefined, undefined, undefined], ['native:4', undefined, undefined, undefined]])
  assert.ok(record.confirm.until > Date.now() && record.confirm.until - Date.now() <= 24 * 3600_000, 'the sound is kept a day at most')
  assert.equal(await invoke('confirm:sound', live.id, 'v0'), null, 'no clip was kept for it')
  await assert.rejects(invoke('confirm:answer', live.id, 'native:1', 'Ivan'), /not waiting/)
  record = await invoke('confirm:answer', live.id, 'native:4', 'Ivan')
  assert.equal(record.transcript.find(line => line.voiceId === 'native:4').voiceName, 'Ivan')
  assert.equal(record.transcript.find(line => line.voiceId === 'native:4').voiceNamedBy, 'user')
  assert.ok(!record.confirm.closed, 'a voice is still to answer')
  assert.equal(record.confirm.voices.find(voice => voice.id === 'native:4').answered, 'Ivan')
  // The call that just ended is still the current call: its own names are corrected too, and a later save of it from its
  // own copy does not bring the old ones back.
  assert.equal(invoke('call:current').transcript.find(line => line.voiceId === 'native:4').voiceName, 'Ivan')
  ipcMain.emit('call:told-others', {}, true)
  await wait(async () => (await invoke('calls:get', live.id)).toldOthers, 'the call saved again')
  record = await invoke('calls:get', live.id)
  assert.equal(record.transcript.find(line => line.voiceId === 'native:4').voiceName, 'Ivan', 'the name the person confirmed survives the next save')
  assert.ok(record.confirm && !record.confirm.closed, 'and the voice still to answer is still asked about')
  await invoke('settings:update', { assist: { rememberCalls: false } })
  record = await invoke('calls:merge-speakers', live.id, 'native:3', 'native:1')
  assert.ok(record.confirm.closed, 'a voice merged into another is no longer asked about, and with none left to answer it closes')
  assert.deepEqual(record.confirm.voices.map(voice => voice.id), ['native:4'])
  await assert.rejects(invoke('confirm:answer', live.id, 'native:3', 'Marta'), /not waiting/, 'nothing is left to answer')
  assert.equal(record.transcript.find(line => line.segmentId === 'native-third').voiceName, 'Diana')
  assert.ok(!invoke('call:current').transcript.some(line => line.voiceId === 'native:3'), 'history corrections also update the current call and survive flushing')
  await invoke('settings:update', { assist: { rememberCalls: true } })
  await assert.rejects(invoke('calls:merge-speakers', live.id, 'missing', 'native:1'), /different speakers/)
  assert.equal(invoke('voices:status').state, 'off')
  record = await invoke('calls:rename', live.id, 'Native integration call')
  assert.equal(record.title, 'Native integration call')
  const exportPath = path.join(profile, 'call-export.md')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath })
  assert.equal(await invoke('calls:export', live.id), exportPath)
  assert.match(fs.readFileSync(exportPath, 'utf8'), /Luka: I will send it by Tuesday\./)
  const encrypted = fs.readFileSync(path.join(profile, 'call-history', live.id + '.bin'))
  assert.ok(!encrypted.includes(Buffer.from('Can you send the SOC2 report?')), 'call content is encrypted by the real OS keystore')
  // The call in Meetings: its row opens its notes, and its transcript is one tab away.
  const row = "[...document.querySelectorAll('.meeting-row')].find(row=>row.getAttribute('aria-label')==='Open call: Native integration call')"
  await evaluate("document.querySelector('.workspace-nav button[aria-label=\"Meetings\"]').click()")
  await wait(() => evaluate('!!' + row), 'real history row')
  await evaluate(row + '.click()')
  await wait(() => evaluate("!!document.querySelector('.call-detail-tabs')"), 'real call details')
  await evaluate("document.querySelector('#meeting-tab-transcript').click()")
  await wait(() => evaluate("document.querySelector('.call-detail-content').textContent.includes('I will send it by Tuesday.')"), 'the transcript')
  await invoke('session:clear')
  record = await invoke('calls:merge-speakers', live.id, 'native:4', 'native:1')
  assert.ok(record.transcript.filter(line => line.speaker === 'them').every(line => line.voiceId === 'native:1' && line.voiceName === 'Diana'), 'archived call corrections are saved independently of the current call')
  // Given to an agent: written as plain text beside the encrypted history, and removed with the call.
  // The call is written to a file first, then each picked task is told where it is: a task that is not there says so.
  const told = await invoke('calls:give', { call: live.id, tasks: ['claude:no-such-task'] })
  assert.equal(told.length, 1); assert.equal(told[0].ok, false)
  const given = path.join(profile, 'shared-calls', live.id + '.md')
  const givenText = fs.readFileSync(given, 'utf8')
  assert.ok(givenText.startsWith('<!-- A record of a call'))
  assert.match(givenText, /Luka: I will send it by Tuesday\./)
  await assert.rejects(invoke('calls:give', { call: 'no-such-call', tasks: ['claude:no-such-task'] }), /no longer available/)
  assert.deepEqual((await invoke('calls:search', 'tuesday')).map(hit => hit.id), [live.id], 'the real history is searched')
  await invoke('calls:delete', live.id)
  assert.equal(fs.existsSync(given), false, 'the text copy goes with the call')
  assert.equal(await invoke('calls:get', live.id), null)
  assert.notEqual(invoke('call:current').key, live.id)
  assert.equal(invoke('call:current').session, undefined)
  await invoke('settings:update', { assist: { rememberCalls: false } })
  const privateCall = await invoke('session:listening', true)
  invoke('dev:transcript', 'them', 'This call should not go into history.')
  await invoke('session:listening', false)
  assert.equal(await invoke('calls:get', privateCall.id), null, 'Remember calls off must prevent durable history')
  await invoke('session:clear')
  await invoke('settings:update', { assist: { rememberCalls: true } })
  const empty = await invoke('session:listening', true)
  await invoke('session:listening', false)
  assert.equal((await invoke('calls:get', empty.id)).transcript.length, 0)
  await invoke('session:clear')
  // Meetings lists every saved call. (Shown again after another place, it is on the call that was open; Meetings pressed once more, or
  // a call that is gone, takes it to the list.)
  await evaluate("document.querySelector('.workspace-nav button[aria-label=\"To-do\"]').click()")
  await evaluate("document.querySelector('.workspace-nav button[aria-label=\"Meetings\"]').click()")
  await evaluate("document.querySelector('.workspace-nav button[aria-label=\"Meetings\"]').click()")
  const saved = (await invoke('calls:list')).map(call => call.id)
  assert.ok(saved.includes(empty.id))
  await wait(() => evaluate(`document.querySelectorAll('.meeting-row').length===${saved.length}`), 'every saved call in Meetings')
  console.log('Native main + renderer: a call pinned to its language, encrypted history, voices named and merged, names confirmed after the call, rename/export/give/search/delete, empty calls and Remember calls off passed.')
  await checkNotesRecovery(evaluate)
  clearTimeout(timeout)
  app.exit(0)
}
run().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
