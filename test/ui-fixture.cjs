// Isolated, deterministic renderer fixtures. No real credentials, devices, model requests, or exports.
const { contextBridge } = require('electron')

module.exports = function install(fixture) {
  const callbacks = new Map()
  const calls = []
  const clone = value => JSON.parse(JSON.stringify(value))
  const record = (name, args) => calls.push({ name, args })
  const merge = (value, patch) => {
    for (const [key, next] of Object.entries(patch)) value[key] = next && typeof next === 'object' && !Array.isArray(next) ? merge({ ...value[key] }, next) : next
    return value
  }
  const empty = () => ({ facts: [], answers: [], skills: [], updates: [], forget: [] })
  const count = lessons => Object.values(lessons).reduce((sum, list) => sum + list.length, 0)
  let sequence = 0, currentKey = 'current-call', currentInfo
  const transcript = clone(fixture.transcript ?? [])
  let rejectAuto = false, rejectSettings = false, rejectStart = fixture.scenario === 'start-failure'
  let holdClear = false, releaseClear
  const apiConnections = []
  const emit = (name, value) => {
    if (name === 'onTranscript') transcript.push(clone(value))
    for (const callback of callbacks.get(name) || []) callback(value)
  }
  const api = Object.fromEntries(fixture.names.map(name => [name, name.startsWith('on') ? callback => {
    const listeners = callbacks.get(name) || new Set(); listeners.add(callback); callbacks.set(name, listeners)
    return () => listeners.delete(callback)
  } : async (...args) => { record(name, args); return [] }]))
  const account = { signedIn: fixture.scenario !== 'account', email: 'demo@example.com' }
  const subscriptions = [
    { id: 'claude-default', provider: 'claude', label: 'Claude Code', shared: true, signedIn: account.signedIn, email: account.email },
    { id: 'chatgpt-default', provider: 'chatgpt', label: 'ChatGPT', shared: true, signedIn: fixture.scenario === 'model-settings', email: fixture.scenario === 'model-settings' ? 'personal@example.test' : undefined },
    { id: 'work-profile', provider: 'claude', label: 'Work', signedIn: true, email: 'luka@work.example', name: 'Luka' }
  ]
  api.subscriptionAccounts = async () => clone(subscriptions)
  api.signInAccount = async id => { record('signInAccount', [id]); const profile = subscriptions.find(item => item.id === id); profile.signedIn = true; profile.email ||= 'connected@example.test'; emit('onAccountsChanged') }
  api.signOutAccount = async id => { record('signOutAccount', [id]); const profile = subscriptions.find(item => item.id === id); profile.signedIn = false; emit('onAccountsChanged') }
  api.apiConnections = async () => clone(apiConnections)
  api.addApiConnection = async input => { record('addApiConnection', [input]); const connection = { id: 'connection:fixture-' + ++sequence, kind: input.kind, label: input.label, baseUrl: input.baseUrl, model: input.model, hasKey: !!input.key, revision: 1 }; apiConnections.push(connection); emit('onApiConnectionsChanged'); return clone(connection) }
  api.removeApiConnection = async id => { record('removeApiConnection', [id]); apiConnections.splice(apiConnections.findIndex(connection => connection.id === id), 1); emit('onApiConnectionsChanged') }
  api.dictationStatus = async () => ({ phase: 'idle' })
  // Togle Studio, the separate app: not installed, unless the scenario has it (installed, running, off; or signed
  // out of it, waiting in its own window for that).
  const signedOut = fixture.scenario === 'togle-microphone-signed-out'
  let microphone = fixture.scenario === 'togle-microphone' || signedOut
    ? { installed: true, running: true, state: { phase: 'off', device: 'Togle Microphone', input: 'USB Headset', systemDefault: false, personalized: true, engine: 'deepfilter', bufferMs: 128, setup: 'ready', ...(signedOut ? { account: 'signed-out' } : {}), version: '0.1.0' } }
    : { installed: false, running: false }
  const microphoneChanged = () => emit('onMicrophone', clone(microphone))
  const microphoneOn = on => ({ ...microphone, state: { ...microphone.state, phase: on ? 'on' : 'off', systemDefault: on } })
  api.microphoneStatus = async () => clone(microphone)
  api.prepareCallMicrophone = async () => {
    record('prepareCallMicrophone', [])
    if (microphone.running && microphone.state.phase === 'off' && microphone.state.account !== 'signed-out' && fixture.settings.microphone?.autoStart !== false) { microphone = { ...microphoneOn(true), forCall: true }; microphoneChanged() }
    return clone(microphone)
  }
  api.turnOnMicrophone = async () => { record('turnOnMicrophone', []); if (!microphone.installed) throw new Error("Togle Studio isn't installed."); microphone = microphoneOn(true); microphoneChanged(); return clone(microphone) }
  api.showMicrophone = async page => { record('showMicrophone', [page]) }
  api.openMicrophonePage = async from => { record('openMicrophonePage', [from]) }
  api.noiseMeasured = async report => { record('noiseMeasured', [report]); return fixture.scenario === 'noisy-call' && fixture.settings.microphone?.suggestions !== false }
  const histories = new Map()
  let rejectHistory = false, rejectNotes = false
  const historyOf = id => histories.get(id) || { enabled: false, entries: [] }
  api.dictationHistory = async id => clone(historyOf(id))
  api.keepDictationHistory = async (id, enabled) => { record('keepDictationHistory', [id, enabled]); const history = { ...historyOf(id), enabled }; histories.set(id, history); return clone(history) }
  const vocabularies = new Map()
  let rejectVocabulary = false
  api.dictationVocabulary = async id => clone(vocabularies.get(id) || { words: [], snippets: [] })
  api.editDictationVocabulary = async (id, edit) => {
    record('editDictationVocabulary', [id, edit])
    if (rejectVocabulary) { rejectVocabulary = false; throw new Error('Vocabulary could not be saved') }
    const value = clone(vocabularies.get(id) || { words: [], snippets: [] })
    value.words = value.words.filter(item => item.id !== edit.id); value.snippets = value.snippets.filter(item => item.id !== edit.id)
    if (edit.kind === 'word') value.words.push({ id: edit.id || 'word-' + ++sequence, word: edit.word, heardAs: edit.heardAs })
    if (edit.kind === 'snippet') value.snippets.push({ id: edit.id || 'snippet-' + ++sequence, phrase: edit.phrase, text: edit.text })
    vocabularies.set(id, value); return clone(value)
  }
  api.voiceStatus = async () => ({ state: 'ready' })
  let remembered = []
  api.rememberedVoices = async () => clone(remembered)
  api.forgetVoice = async id => { record('forgetVoice', [id]); remembered = remembered.filter(person => person.id !== id); emit('onRememberedVoicesChanged') }
  api.renameVoice = async (id, name, identity) => {
    record('renameVoice', [id, name, identity])
    let person
    if (fixture.settings.assist.rememberVoices === true) {
      person = remembered.find(person => person.id === identity)
      if (!person) { person = { id: 'person-' + ++sequence, name, createdAt: Date.now(), updatedAt: Date.now() }; remembered.push(person) }
    }
    for (const line of transcript) if (line.voiceId === id) { line.voiceName = person?.name ?? name; line.voiceNamedBy = 'user'; line.voiceIdentityId = person?.id }
    emit('onTranscriptUpdated', clone(transcript.filter(line => line.voiceId === id)))
    emit('onRememberedVoicesChanged')
    return person ? { state: 'remembered', person: clone(person) } : { state: 'off' }
  }
  const combine = (lines, from, into) => {
    const target = lines.find(line => line.voiceId === into)
    if (!target) throw new Error('Choose a speaker.')
    for (const line of lines) if (line.voiceId === from) { line.voiceId = into; line.voiceName = target.voiceName; line.voiceNamedBy = target.voiceNamedBy }
  }
  api.mergeVoices = async (from, into) => {
    record('mergeVoices', [from, into]); combine(transcript, from, into)
    emit('onTranscriptUpdated', clone(transcript.filter(line => line.voiceId === into)))
  }
  let local = { dev: false, installed: fixture.readyAudio ? ['parakeet'] : [], offer: { gpu: false, engine: 1000000, models: [{ id: 'parakeet', label: 'Parakeet', bytes: 669000000, recommended: true }, { id: 'whisper-turbo', label: 'Whisper large-v3-turbo', bytes: 574000000, recommended: false }, { id: 'whisper-small', label: 'Whisper small', bytes: 190000000, recommended: true }, { id: 'whisper-base', label: 'Whisper base', bytes: 148000000, recommended: false }] } }
  let sessions = fixture.sessions || fixture.agents.map(agent => ({
    version: 1, id: 'history-' + agent.id, agentId: agent.id, agentName: agent.name, startedAt: Date.UTC(2026, 9, 28, 10), endedAt: Date.UTC(2026, 9, 28, 10, 30), status: 'ended', updatedAt: 1000,
    title: agent.name === 'Support' ? 'Webhook support call' : 'Acme renewal', brief: agent.name === 'Support' ? 'Webhook support call' : 'Acme renewal', group: false, frameSession: 'frames-' + agent.id,
    summary: agent.name === 'Support' ? 'Deduplicate webhook events by event ID.' : 'Send the SOC2 report by Tuesday.',
    transcript: [{ id: 'old-them', speaker: 'them', text: 'When is the report due?', at: 1000, end: 2000 }, { id: 'old-me', speaker: 'me', text: 'I will send the report by Tuesday.', at: 3000, end: 4000 }],
    suggestions: [{ id: 'old-reply', kind: 'suggest', question: 'When is the report due?', text: 'Tuesday.', at: 2000 }],
    notes: '', callAnswers: [], learning: { state: 'not-reviewed', pending: empty(), changes: [] }
  }))
  // Notes in Markdown with all it can hold: links that open outside, and a picture and a script that must never load or run.
  if (fixture.richText) Object.assign(sessions[0], { summary: fixture.richText, minutes: { state: 'ready', template: 'concise', revision: 'rich-notes', edited: false } })
  // Two calls with voices to confirm after them: one to answer, one to skip.
  if (fixture.scenario === 'confirm-names') {
    const base = sessions[0], line = (id, voiceId, text, at, name, by) => ({ id, speaker: 'them', voiceId, text, at, end: at + 4000, ...(name ? { voiceName: name, voiceNamedBy: by } : {}) })
    const until = Date.now() + 6 * 3600_000
    sessions.unshift(
      { ...clone(base), id: 'confirm-call', title: 'Sprint review', startedAt: Date.now() - 7200_000, endedAt: Date.now() - 3600_000, transcript: [line('c1', 'voice:1', 'Then the API timeline has to move to the end of the month.', 1000), line('c2', 'voice:2', 'I can take the staging logs.', 9000)],
        confirm: { until, voices: [
          { id: 'voice:1', guess: 'Marta', reason: 'Dario said “Marta” just before.', said: 'Then the API timeline has to move to the end of the month.', clip: 'v0', seconds: 5 },
          { id: 'voice:2', said: 'I can take the staging logs.', clip: 'v1', seconds: 4 }] } },
      { ...clone(base), id: 'confirm-skip', title: 'Design check', startedAt: Date.now() - 9000_000, endedAt: Date.now() - 8000_000, transcript: [line('s1', 'voice:1', 'The new header looks right to me.', 1000)],
        confirm: { until, voices: [{ id: 'voice:1', said: 'The new header looks right to me.', clip: 'v0', seconds: 4 }] } })
  }
  if (fixture.scenario === 'large-history') {
    sessions.push(...Array.from({ length: 120 }, (_, index) => ({ ...sessions[0], id: 'older-' + index, title: 'Older call ' + index, transcript: [], suggestions: [] })))
  }
  const summary = session => {
    const { transcript, suggestions, notes, callAnswers, learning, ...info } = session
    return { ...info, lines: transcript.length, replies: suggestions.length, learningState: learning.state, pendingLessons: count(learning.pending), learned: learning.changes.length }
  }
  // What the person did during the call besides listening: told the others, and the moments they marked.
  let flags = { toldOthers: 0, marks: [] }
  const current = () => ({ session: currentInfo, key: currentKey, transcript: clone(transcript), toldOthers: flags.toldOthers, marks: [...flags.marks] })
  api.setToldOthers = told => { record('setToldOthers', [told]); flags = { ...flags, toldOthers: told ? flags.toldOthers || Date.now() : 0 }; emit('onCallFlags', clone(flags)) }
  api.markCall = async () => { record('markCall', []); flags = { ...flags, marks: [...flags.marks, Date.now()] }; emit('onCallFlags', clone(flags)); return [...flags.marks] }
  const capture = () => {
    if (!currentInfo || fixture.settings.assist.rememberCalls === false) return
    const previous = sessions.find(session => session.id === currentKey)
    const value = { version: 1, ...currentInfo, title: previous?.customTitle ? previous.title : currentInfo.meeting?.title || previous?.title || 'Untitled call', frameSession: currentKey, updatedAt: Date.now(), brief: '', group: false, transcript: clone(transcript), suggestions: [], notes: '', callAnswers: [], summary: previous?.summary || '', learning: previous?.learning || { state: 'not-reviewed', pending: empty(), changes: [] } }
    sessions = [...sessions.filter(session => session.id !== currentKey), value]
    emit('onCallSessions', { id: currentKey })
  }
  const needSession = id => { const session = sessions.find(session => session.id === id); if (!session) throw new Error('No such call.'); return session }
  const needAgent = id => { const agent = fixture.agents.find(agent => agent.id === id); if (!agent) throw new Error('No such agent.'); return agent }
  api.platform = fixture.platform ?? process.platform
  api.listHotkeys = async () => [{ id: 'dictate', keys: 'F9', defaultKeys: 'F9', label: 'Talk', ok: true }, { id: 'show', keys: 'F8', defaultKeys: 'F8', label: 'Show', ok: true }, { id: 'task', keys: 'F10', defaultKeys: 'F10', label: 'Task', ok: true }]
  api.getSettings = async () => clone(fixture.settings)
  api.authStatus = async () => ({ signedIn: false })
  api.sttStatus = async () => {
    // No sign-in hears speech: calls are heard by this PC's models (or a speech API, which these flows don't pick).
    const t = fixture.settings.transcription
    const ready = local.installed.length > 0
    // As the app says it: speech recognition missing from this computer isn't a service that "needs" a key.
    return { state: ready ? 'ready' : 'missing', transcriptionLanguage: t.language }
  }
  api.localSpeech = async () => clone(local)
  api.listModels = async sourceId => {
    record('listModels', [sourceId])
    const connection = apiConnections.find(connection => connection.id === sourceId)
    if (connection) return [{ id: connection.model || 'local-fixture', label: connection.model || 'Local fixture' }]
    if (fixture.scenario !== 'model-settings') return [{ id: 'haiku', label: 'Haiku', reasoningLevels: ['low', 'medium', 'high'] }]
    if (sourceId?.startsWith('chatgpt') || subscriptions.find(account => account.id === sourceId)?.provider === 'chatgpt') return [{ id: 'gpt-6-luna', label: 'GPT Luna', reasoningLevels: ['low', 'medium'] }, { id: 'gpt-6.1-sol', label: 'GPT Sol', reasoningLevels: ['low', 'medium', 'high'] }]
    return [{ id: 'opus', label: 'Claude Opus', reasoningLevels: ['low', 'medium', 'high'] }, { id: 'sonnet', label: 'Claude Sonnet', reasoningLevels: ['low', 'medium', 'high'] }, { id: 'haiku', label: 'Claude Haiku', reasoningLevels: ['low', 'medium', 'high'] }]
  }
  api.currentCall = async () => current()
  api.clearTranscript = async () => {
    record('clearTranscript', []); if (holdClear) await new Promise(resolve => { releaseClear = resolve })
    flags = { toldOthers: 0, marks: [] }; currentInfo = undefined; currentKey = 'current-call-' + ++sequence; transcript.splice(0); return current()
  }
  api.callSessions = async () => { record('callSessions', []); return clone(sessions.map(summary)) }
  api.callSession = async id => { record('callSession', [id]); return clone(sessions.find(session => session.id === id) || null) }
  api.generateCallNotes = async (id, template, revision) => {
    record('generateCallNotes', [id, template, revision]); const session = needSession(id)
    if (session.minutes?.revision !== revision) throw new Error('These notes changed')
    if (rejectNotes) { rejectNotes = false; throw new Error('Notes could not be generated') }
    session.summary = '## Decisions\nThe report is due Tuesday. [0:03]\n\n## Action items\nSend the report. Owner not assigned. [0:03]'
    session.minutes = { state: 'ready', template, revision: 'minutes-' + ++sequence, edited: false, by: 'chatgpt' }
    emit('onCallSessions', { id }); return clone(session)
  }
  api.saveCallNotes = async (id, revision, text) => {
    record('saveCallNotes', [id, revision, text]); const session = needSession(id)
    if (session.minutes?.revision !== revision) throw new Error('These notes changed')
    if (rejectNotes) { rejectNotes = false; throw new Error('Notes could not be saved') }
    session.summary = text; session.minutes = { ...session.minutes, state: 'ready', template: session.minutes?.template || 'concise', revision: 'minutes-' + ++sequence, edited: true }
    emit('onCallSessions', { id }); return clone(session)
  }
  api.savePersonalCallNotes = async (id, before, text) => {
    record('savePersonalCallNotes', [id, before, text]); const session = needSession(id)
    if ((session.personalNotes || '') !== before) throw new Error('Your notes changed')
    session.personalNotes = text; emit('onCallSessions', { id }); return clone(session)
  }
  api.confirmSound = async (id, clip) => { record('confirmSound', [id, clip]); return new Float32Array(1600) }
  api.confirmAnswer = async (id, voiceId, name) => {
    record('confirmAnswer', [id, voiceId, name]); const session = needSession(id), value = (name || '').trim()
    session.confirm.voices = session.confirm.voices.map(voice => voice.id === voiceId ? { ...voice, answered: value } : voice)
    if (value) for (const line of session.transcript) if (line.voiceId === voiceId) { line.voiceName = value; line.voiceNamedBy = 'user' }
    if (session.confirm.voices.every(voice => voice.answered !== undefined)) session.confirm.closed = Date.now()
    emit('onCallSessions', { id }); return clone(session)
  }
  api.searchCalls = async query => {
    record('searchCalls', [query])
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
    const has = text => words.every(word => text.toLowerCase().includes(word))
    return clone(sessions.filter(session => session.transcript.some(line => has(line.text))).map(session => ({ id: session.id, title: session.title, startedAt: session.startedAt, lines: session.transcript.filter(line => has(line.text)).slice(0, 3).map(line => ({ at: line.at, who: line.voiceName || 'Them', text: line.text })) })))
  }
  api.giveCallToAgent = async id => { record('giveCallToAgent', [id]) }
  api.confirmFinish = async id => { record('confirmFinish', [id]); const session = needSession(id); session.confirm.closed = Date.now(); emit('onCallSessions', { id }); return clone(session) }
  api.mergeCallSpeakers = async (id, from, into) => {
    record('mergeCallSpeakers', [id, from, into]); const session = needSession(id); combine(session.transcript, from, into)
    if (id === currentKey) { combine(transcript, from, into); emit('onTranscriptUpdated', clone(transcript.filter(line => line.voiceId === into))) }
    emit('onCallSessions', { id }); return clone(session)
  }
  api.renameCallSession = async (id, title) => { record('renameCallSession', [id, title]); const session = needSession(id); session.title = title; emit('onCallSessions', { id }); return clone(session) }
  api.deleteCallSession = async id => {
    record('deleteCallSession', [id]); if (needSession(id).status === 'live') throw new Error('End the call first.')
    sessions = sessions.filter(session => session.id !== id)
    if (id === currentKey) { await api.clearTranscript(); emit('onCallReset', current()) }
    emit('onCallSessions', { id })
  }
  api.exportCallSession = async id => { record('exportCallSession', [id]); return 'C:\\exports\\call.md' }
  api.updateSettings = async patch => {
    record('updateSettings', patch)
    if (rejectSettings) { rejectSettings = false; throw new Error('Settings could not be saved') }
    if (rejectAuto && patch.assist?.auto !== undefined) { rejectAuto = false; throw new Error('Settings could not be saved') }
    if (patch.subscriptionAccountId) { const selected = subscriptions.find(item => item.id === patch.subscriptionAccountId); if (selected) patch = { ...patch, provider: selected.provider, ...(selected.provider === 'claude' ? { claude: { ...patch.claude, auth: 'subscription' } } : {}) } }
    fixture.settings = merge(clone(fixture.settings), patch); if ('ai' in patch) fixture.settings.ai = clone(patch.ai); emit('onSettingsChanged', clone(fixture.settings))
    if (patch.transcription || patch.subscriptionAccountId || patch.provider) emit('onSttStatus', await api.sttStatus())
    return clone(fixture.settings)
  }
  api.setListening = async (active, meetingId) => {
    record('setListening', meetingId ? [active, meetingId] : [active]); if (active && rejectStart) { rejectStart = false; throw new Error('Call service could not start') }
    if (active) { currentInfo = { id: currentKey, agentId: fixture.settings.activeAgentId, agentName: needAgent(fixture.settings.activeAgentId).name, startedAt: currentInfo?.startedAt ?? Date.now(), status: 'live', meeting: currentInfo?.meeting }; capture() }
    else if (currentInfo) { currentInfo = { ...currentInfo, status: 'ended', endedAt: Date.now() }; capture() }
    return clone(currentInfo || null)
  }
  api.installLocalSpeech = async models => { record('installLocalSpeech', models); local = { ...local, installed: models }; emit('onLocalSpeech', clone(local)); emit('onSttStatus', { state: 'ready' }); return clone(local) }
  // The coding agents' tasks (the Tasks screen), in memory so that a test can answer, stop and start them.
  const hour = 3600000
  const task = (key, props) => ({ key, runner: key.split(':')[0], id: key.split(':')[1], folder: 'C:\\work\\site', state: 'idle', updatedAt: Date.now(), mine: false, line: '', pending: [], commandsRunning: false, log: [], ...props })
  const runnerTasks = fixture.scenario !== 'tasks' ? [] : [
    task('codex:t1', { title: 'Add the status column', folder: 'C:\\work\\api-server', state: 'waiting', updatedAt: Date.now() - 60000, mine: true, line: 'Wants to run npm run migrate',
      pending: [{ id: 'r1', kind: 'command', command: 'npm run migrate', raw: 'npm run migrate', folder: 'C:\\work\\api-server', offersAlways: true, always: 'Always allow commands that start with npm run' }],
      log: [{ id: 1, at: 1, kind: 'you', text: 'Add a status column to the orders table.' }, { id: 2, at: 2, kind: 'agent', text: 'I will add the column and a migration.' }, { id: 3, at: 3, kind: 'command', text: 'git status', status: 'finished' }, { id: 4, at: 4, kind: 'files', text: 'Changed 2 files: src/db/orders.ts, migrations/004.sql', paths: ['src/db/orders.ts', 'migrations/004.sql'] }] }),
    task('claude:s5', { title: 'Clean the build folder', folder: 'C:\\work\\website', state: 'waiting', updatedAt: Date.now() - 120000, mine: true, line: 'Wants to run rm -rf build',
      pending: [{ id: 'r2', kind: 'command', command: 'rm -rf build', raw: 'rm -rf build', folder: 'C:\\work\\website', offersAlways: true, always: 'Always allow this command in website', danger: 'It deletes files or folders for good.' }],
      log: [{ id: 5, at: 5, kind: 'you', text: 'Clean up the build folder.' }, { id: 6, at: 6, kind: 'asked', text: 'rm -rf build' }] }),
    task('claude:s2', { title: 'Rebuild the pricing page', folder: 'C:\\work\\website', state: 'working', mine: true, line: 'Running npm test',
      log: [{ id: 7, at: 7, kind: 'you', text: 'Rebuild the pricing page with two plans.' }, { id: 8, at: 8, kind: 'agent', text: '**Two plans** it is. I will start with the table.' }, { id: 9, at: 9, kind: 'command', text: 'npm test', status: 'running' }] }),
    task('claude:s4', { title: 'Write the release notes', folder: 'C:\\work\\notes', state: 'working', pid: 4242, line: 'Working in its own window' }),
    task('claude:s3', { title: 'Fix the login redirect', folder: 'C:\\work\\website', updatedAt: Date.now() - 5 * hour }),
    task('codex:t9', { title: 'Port the settings screen', folder: 'C:\\work\\mobile-app', updatedAt: Date.now() - 72 * hour })
  ]
  const runnerView = ({ log, ...view }) => view
  const runnerFind = key => { const found = runnerTasks.find(item => item.key === key); if (!found) throw new Error('That task is gone.'); return found }
  const runnerRank = item => item.state === 'waiting' ? 0 : item.state === 'working' ? 1 : 2
  const runnerChanged = () => emit('onRunnersChanged')
  // Agents added in Settings, in memory: any that speaks ACP, by name and command.
  const addedAgents = []
  const knownAgents = () => fixture.scenario === 'tasks' ? [{ runner: 'claude', name: 'Claude Code', installed: true, version: '2.1.322' }, { runner: 'codex', name: 'Codex', installed: true, version: '0.166.0' }, { runner: 'hermes', name: 'Hermes', installed: false }] : []
  api.runnerStatus = async () => [...knownAgents(), ...clone(addedAgents)]
  api.addCodingAgent = async (name, command) => { record('addCodingAgent', [name, command]); addedAgents.push({ runner: 'acp-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, installed: true, added: true }); return api.runnerStatus() }
  api.removeCodingAgent = async id => { record('removeCodingAgent', [id]); addedAgents.splice(addedAgents.findIndex(agent => agent.runner === id), 1); return api.runnerStatus() }
  api.runnerTasks = async () => clone(runnerTasks.map(runnerView)).sort((a, b) => runnerRank(a) - runnerRank(b) || b.updatedAt - a.updatedAt)
  api.runnerDetail = async key => { const found = runnerFind(key); return clone({ task: runnerView(found), log: found.log }) }
  let failTask = false
  api.startRunnerTask = async request => {
    record('startRunnerTask', [request])
    if (failTask) { failTask = false; throw new Error('That folder is not there.') }
    const started = task('claude:new' + ++sequence, { title: request.prompt.slice(0, 40), folder: request.folder, runner: request.runner, state: 'working', mine: true, line: 'Working…', log: [{ id: 100 + sequence, at: Date.now(), kind: 'you', text: request.prompt }] })
    started.key = request.runner + ':new' + sequence
    runnerTasks.push(started); runnerChanged()
    // As the main process does: the task is on the to-do list, as the item it was given from (when that is as it was) or
    // an item of its own.
    const item = request.todo && todoItems[request.todo.line]
    if (item && item.text === request.todo.text) item.task = started.key
    else todoItems.push({ text: started.title, done: false, task: started.key })
    emit('onTodoChanged')
    return clone(runnerView(started))
  }
  api.openRunnerTask = async key => { record('openRunnerTask', [key]); const found = runnerFind(key); found.mine = true; runnerChanged(); return clone(runnerView(found)) }
  api.takeOverRunnerTask = async key => { record('takeOverRunnerTask', [key]); const found = runnerFind(key); found.mine = true; delete found.pid; found.line = ''; runnerChanged(); return clone(runnerView(found)) }
  api.sendToRunnerTask = async (key, text) => { record('sendToRunnerTask', [key, text]); const found = runnerFind(key); found.log.push({ id: 200 + ++sequence, at: Date.now(), kind: 'you', text }); found.state = 'working'; found.line = 'Working…'; runnerChanged() }
  api.answerRunnerTask = async (key, requestId, decision) => {
    record('answerRunnerTask', [key, requestId, decision]); const found = runnerFind(key)
    found.pending = found.pending.filter(request => request.id !== requestId)
    found.log.push({ id: 300 + ++sequence, at: Date.now(), kind: 'note', text: decision === 'refuse' ? 'You refused it.' : 'You allowed it.' })
    if (!found.pending.length) { found.state = 'working'; found.line = 'Working…' }
    runnerChanged()
  }
  api.replyRunnerTask = async (key, requestId, text) => { record('replyRunnerTask', [key, requestId, text]); runnerFind(key).pending = []; runnerChanged() }
  api.stopRunnerTask = async key => { record('stopRunnerTask', [key]); const found = runnerFind(key); found.state = 'stopped'; found.pending = []; found.line = ''; if (found.runner === 'codex') found.commandsRunning = true; runnerChanged() }
  api.endRunnerCommands = async key => { record('endRunnerCommands', [key]); runnerFind(key).commandsRunning = false; runnerChanged(); return 1 }
  api.closeRunnerTask = async key => { record('closeRunnerTask', [key]); runnerFind(key).mine = false; runnerChanged() }
  api.pickRunnerFolder = async () => { record('pickRunnerFolder', []); return 'C:\\work\\picked' }
  api.pickTaskBoxFolder = async () => { record('pickTaskBoxFolder', []); return 'C:\\work\\chosen-for-box' }
  api.openTaskBox = async opening => { record('openTaskBox', [opening]) }
  // What the box was opened with before its page listened (its first opening), when a test gives it one.
  api.taskBoxOpening = async () => clone(fixture.taskBoxOpening ?? null)
  // Claude Code in a terminal asking Togle: the connection, as the window is told it.
  let hookStatus = { claude: fixture.scenario === 'tasks', version: '2.1.322 (Claude Code)', supported: true, minimum: '2.1.139', installed: false, current: false, file: 'C:\\Users\\demo\\.claude\\settings.json' }
  let failHook = false
  api.claudeHookStatus = async () => clone(hookStatus)
  api.connectClaudeHook = async () => {
    record('connectClaudeHook', [])
    if (failHook) { failHook = false; throw new Error("Claude Code's settings file is not valid JSON, so Togle left it alone.") }
    hookStatus = { ...hookStatus, installed: true, current: true }
    return clone(hookStatus)
  }
  api.disconnectClaudeHook = async () => { record('disconnectClaudeHook', []); hookStatus = { ...hookStatus, installed: false, current: false }; return clone(hookStatus) }
  // What differs from the last commit: a repository for every folder but the notes one.
  const sampleDiff = [
    'diff --git a/src/status.ts b/src/status.ts', 'index 1111111..2222222 100644', '--- a/src/status.ts', '+++ b/src/status.ts', '@@ -1,3 +1,3 @@',
    " export const columns = ['id', 'name']", "+export const status = 'status'", '-const old = 1', ' export default columns',
    'diff --git a/migrations/003_add_status.sql b/migrations/003_add_status.sql', 'new file', '--- /dev/null', '+++ b/migrations/003_add_status.sql', '@@ -0,0 +1,2 @@',
    '+ALTER TABLE orders ADD COLUMN status text;', "+UPDATE orders SET status = 'open';", ''
  ].join('\n')
  api.runnerChanges = async key => {
    record('runnerChanges', [key])
    if (runnerFind(key).folder === 'C:\\work\\notes') return { git: false, problem: 'This folder is not in a git repository, so Togle cannot tell what changed.', files: [], diff: '', truncated: false }
    return clone({ git: true, branch: 'main', files: [{ path: 'src/status.ts', status: 'modified', added: 1, removed: 1 }, { path: 'migrations/003_add_status.sql', status: 'new', added: 2, removed: 0 }], diff: sampleDiff, truncated: false })
  }
  // The to-do list, in memory: the lines of its file, each with the words it had when it was shown.
  const todoItems = fixture.scenario === 'tasks' ? [
    { text: 'Review the onboarding copy', done: false },
    { text: 'Fix the login redirect', done: false, task: 'claude:s2' },
    { text: 'Write the release notes', done: false, task: 'claude:s3' },
    { text: 'Send the invoice to Marta', done: true }
  ] : []
  const todoView = () => ({ items: todoItems.map((item, line) => ({ line, text: item.text, done: item.done, ...(item.task ? { task: item.task } : {}) })), file: 'C:\\Users\\demo\\AppData\\Roaming\\Togle\\to-do.md' })
  const todoAt = ref => { const item = todoItems[ref.line]; if (!item || item.text !== ref.text) throw new Error('The list changed while you were looking at it. Look at it again.'); return item }
  api.todoList = async () => clone(todoView())
  api.addTodo = async text => { record('addTodo', [text]); if (!text.trim()) throw new Error('Say what the item is.'); todoItems.push({ text: text.trim(), done: false }); return clone(todoView()) }
  api.setTodoDone = async (ref, done) => { record('setTodoDone', [ref, done]); todoAt(ref).done = done; return clone(todoView()) }
  api.editTodo = async (ref, text) => { record('editTodo', [ref, text]); todoAt(ref).text = text; return clone(todoView()) }
  api.removeTodo = async ref => { record('removeTodo', [ref]); todoAt(ref); todoItems.splice(ref.line, 1); return clone(todoView()) }
  // What calls left for today, in the scenario with a to-do list: names to confirm, notes ready, to-dos that are the person's.
  api.meetingOffers = async () => fixture.scenario === 'tasks'
    ? clone({
      calls: [{ id: 'sprint', title: 'Sprint review', startedAt: Date.now() - 3600_000, notes: true, toConfirm: 2 }, { id: 'planning', title: 'Planning sync', startedAt: Date.now() - 7200_000, notes: true, toConfirm: 0 }],
      items: [{ callId: 'planning', title: 'Planning sync', startedAt: Date.now() - 7200_000, text: 'Send the API timeline to Dario.' }, { callId: 'planning', title: 'Planning sync', startedAt: Date.now() - 7200_000, text: 'Book the staging review.' }]
    })
    : { calls: [], items: [] }
  api.linkTodo = async (ref, task) => { record('linkTodo', [ref, task]); const item = todoAt(ref); if (task) item.task = task; else delete item.task; return clone(todoView()) }
  api.showTodoFile = async () => { record('showTodoFile', []) }
  // F8 Show's overlay: the frozen screen it shows, and the picture it gives back (its first bytes and its size, from the
  // PNG's header).
  api.showPicture = async () => fixture.showPicture ?? null
  api.showDone = png => { const view = new DataView(png.buffer, png.byteOffset, png.byteLength); record('showDone', [{ head: [...png.slice(0, 8)], width: view.getUint32(16), height: view.getUint32(20) }]) }
  api.showCancel = () => { record('showCancel', []) }
  contextBridge.exposeInMainWorld('togle', api)
  // A noisy call's measurement, as the capture's noise check reports it when the call ends (the audio here is silent).
  const noiseReport = () => ({ analyzedMs: 600000, speechMs: 180000, quietMs: 360000, noisyMs: 162000, bursts: 41, floorDb: -47, peakDb: -38, speechDb: -24, snrDb: 23, verdict: 'noisy', sample: new Float32Array(1600) })
  contextBridge.exposeInMainWorld('togleDev', { silentAudio: !['audio', 'start-failure'].includes(fixture.scenario), ...(fixture.scenario === 'noisy-call' ? { noiseReport } : {}) })
  contextBridge.exposeInMainWorld('togleUITest', {
    // A session that runs in a terminal asks about a command and the question is held here: it waits, and can be answered.
    askOutside: (key, request) => { const found = runnerFind(key); found.pending = [clone(request)]; found.state = 'waiting'; found.line = 'Wants to run ' + (request.command ?? ''); runnerChanged() },
    // A task Togle runs stops: by the person's Stop, or by itself (an error, or its agent signed out: `extra`).
    stopTask: (key, state, line, extra) => { const found = runnerFind(key); found.state = state; found.line = line; found.pending = []; Object.assign(found, extra ?? {}); runnerChanged() },
    // What the window is told of Claude Code's connection to Togle, changed by hand.
    hook: patch => { hookStatus = { ...hookStatus, ...patch } },
    failNextConnect: () => { failHook = true },
    failNextTask: () => { failTask = true },
    microphone: status => { microphone = clone(status); microphoneChanged() },
    calls: () => clone(calls), emit, settings: () => clone(fixture.settings),
    failNextAuto: () => { rejectAuto = true }, failNextSettings: () => { rejectSettings = true }, holdNextClear: () => { holdClear = true }, releaseClear: () => { holdClear = false; releaseClear?.() },
    failNextVocabulary: () => { rejectVocabulary = true },
    failNextHistory: () => { rejectHistory = true }, failNextNotes: () => { rejectNotes = true },
    dictationEntry: (id, text) => { const history = historyOf(id); if (!history.enabled) return; history.entries.unshift({ id: 'dictation-' + ++sequence, revision: 'entry-' + sequence, text, originalText: text, startedAt: Date.now() - 3000, finishedAt: Date.now(), destination: 'Slack', outcome: 'inserted' }); histories.set(id, history) },
    notesChanged: (id, text) => { const session = needSession(id); session.summary = text; session.minutes = { state: 'ready', template: 'concise', revision: 'remote-' + ++sequence }; emit('onCallSessions', { id }) }
  })
}
