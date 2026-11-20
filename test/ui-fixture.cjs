// Isolated, deterministic renderer fixtures. No real credentials, devices, model requests, or exports.
const { contextBridge, webUtils } = require('electron')

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
  // The plan sign-ins: ChatGPT's only. Togle has no Claude sign-in (a Claude API key is a connection, below).
  const subscriptions = [
    { id: 'chatgpt-default', provider: 'chatgpt', label: 'ChatGPT', shared: true, signedIn: fixture.scenario === 'model-settings', email: fixture.scenario === 'model-settings' ? 'personal@example.test' : undefined }
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
  // Opening it can fail, as it does when the program is gone: the message comes back the way a main-process error does.
  let showFails = ''
  api.showMicrophone = async page => {
    record('showMicrophone', [page])
    if (showFails) { const failure = showFails; showFails = ''; throw new Error("Error invoking remote method 'microphone:show': Error: " + failure) }
  }
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
  if (fixture.scenario === 'meeting-account') {
    subscriptions[0].signedIn = true
    const call = sessions[0]
    for (const [id, title] of [['other', 'Project planning'], ['spare', 'Spare meeting']]) sessions.push({ ...clone(call), id, title })
    Object.assign(call, { title: 'Angell <> Luka Monthly 1:1', accountId: 'claude-default',
      summary: '## Key points\n- Previous notes. [2:35]\n\n## Open questions\n- Speaker identities are unconfirmed.',
      minutes: { template: 'detailed', revision: 'account-error', state: 'error', error: 'This subscription account is unavailable. Choose an account in the agent’s settings.' },
      transcript: call.transcript.map(line => ({ ...line, voiceId: line.speaker === 'me' ? 'me' : 'voice:1', voiceName: line.speaker === 'me' ? 'Luka' : 'Angell', voiceNamedBy: 'user' })) })
  }
  if (fixture.scenario === 'meeting-review') {
    const call = sessions[0]
    call.title = 'Testing Strategy and Environment Cleanup'
    call.summary = [
      '## Decided', '- Merge the PR. [4:48]', '- Remove the environment. [5:10–6:03]', '',
      '## To do', '- You (speaker labeled “Luka?”, identity tentative): Review the tickets. [1:57–2:54, 4:26]',
      '- You (speaker labeled “Luka?”, identity tentative): Retry merging. [3:34–4:13, 4:46]'
    ].join('\n')
    call.minutes = { state: 'ready', template: 'concise', revision: 'review', edited: false, by: 'chatgpt' }
    call.transcript = Array.from({ length: 140 }, (_, i) => ({
      id: 'review-' + i, text: 'Review item ' + i, at: call.startedAt + i * 3000, end: call.startedAt + i * 3000 + 1900,
      speaker: i % 2 ? 'them' : 'me', voiceId: i % 2 ? 'voice:2' : i ? 'me' : undefined,
      voiceName: i % 2 ? 'Dennis' : 'Luka', voiceNamedBy: i % 2 ? 'user' : 'suggested'
    }))
  }
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
    const value = { version: 1, ...currentInfo, marks: [...flags.marks], title: previous?.customTitle ? previous.title : currentInfo.meeting?.title || previous?.title || 'Untitled call', frameSession: currentKey, updatedAt: Date.now(), brief: '', group: false, transcript: clone(transcript), suggestions: [], notes: '', callAnswers: [], summary: previous?.summary || '', learning: previous?.learning || { state: 'not-reviewed', pending: empty(), changes: [] } }
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
    // Anthropic lists its models, the newest first; the others here list one.
    if (connection?.kind === 'anthropic') return ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => ({ id, label: id, reasoningLevels: ['low', 'medium', 'high'] }))
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
  api.generateCallNotes = async (id, template, revision, sourceId) => {
    record('generateCallNotes', sourceId ? [id, template, revision, sourceId] : [id, template, revision]); const session = needSession(id)
    if (session.minutes?.revision !== revision) throw new Error('These notes changed')
    if (rejectNotes) { rejectNotes = false; throw new Error('Notes could not be generated') }
    session.summary = '## Decisions\nThe report is due Tuesday. [0:03]\n\n## Action items\nSend the report. Owner not assigned. [0:03]'
    session.minutes = { state: 'ready', template, revision: 'minutes-' + ++sequence, sourceId: sourceId ?? session.minutes?.sourceId, edited: false, by: 'chatgpt' }
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
  api.renameCallSpeaker = async (id, voiceId, name) => {
    record('renameCallSpeaker', [id, voiceId, name])
    const session = needSession(id)
    const lines = session.transcript.filter(line => (line.voiceId ?? (line.speaker === 'me' ? 'me' : undefined)) === voiceId)
    if (!lines.length) throw new Error('No such speaker.')
    for (const line of lines) Object.assign(line, { voiceId, voiceName: name, voiceNamedBy: 'user' })
    emit('onCallSessions', { id })
    return clone(session)
  }
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
    return clone(sessions.filter(session => has(session.title) || has(session.summary) || session.transcript.some(line => has(line.text))).map(session => ({ id: session.id, title: session.title, startedAt: session.startedAt, lines: session.transcript.filter(line => has(line.text)).slice(0, 3).map(line => ({ at: line.at, who: line.voiceName || 'Them', text: line.text })) })))
  }
  // Agents on a call, in memory: the tasks connected to each call, and what giving a call to agents answered.
  const callAgentLists = new Map()
  api.callAgents = async call => { record('callAgents', [call]); return clone(callAgentLists.get(call) ?? { keys: [], sent: {} }) }
  api.setCallAgents = async (call, keys) => { record('setCallAgents', [call, keys]); const next = { keys: [...new Set(keys)], sent: {} }; callAgentLists.set(call, next); return clone(next) }
  api.giveCall = async request => {
    record('giveCall', [request])
    const results = request.tasks.map(key => (fixture.giveFails?.[key] ? { key, ok: false, problem: fixture.giveFails[key] } : { key, ok: true }))
    // A new task that cannot start is a failure under "<agent>:", as main reports it (giveFails('claude:', why) makes one).
    if (request.start) {
      const startKey = request.start.runner + ':'
      results.push(fixture.giveFails?.[startKey] ? { key: startKey, ok: false, problem: fixture.giveFails[startKey] } : { key: request.start.runner + ':newcall', ok: true, title: request.prompt.slice(0, 40) })
    }
    const list = callAgentLists.get(request.call) ?? { keys: [], sent: {} }
    if (request.connect) list.keys = [...new Set([...list.keys, ...results.filter(result => result.ok).map(result => result.key)])]
    for (const result of results) if (result.ok && list.keys.includes(result.key)) list.sent[result.key] = Date.now()
    callAgentLists.set(request.call, list)
    return clone(results)
  }
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
    if (patch.subscriptionAccountId) { const selected = subscriptions.find(item => item.id === patch.subscriptionAccountId); if (selected) patch = { ...patch, provider: selected.provider } }
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
  // When something in a task's conversation was said: so many seconds ago, as an agent's record keeps it.
  const ago = seconds => Date.now() - seconds * 1000
  // (`terminals` is further down: Take over writes into it when it is called, long after both exist.)
  const task = (key, props) => ({ key, runner: key.split(':')[0], id: key.split(':')[1], folder: 'C:\\work\\site', state: 'idle', updatedAt: Date.now(), mine: false, line: '', pending: [], commandsRunning: false, log: [], ...props })
  const runnerTasks = fixture.scenario !== 'tasks' ? [] : [
    task('codex:t1', { title: 'Add the status column', folder: 'C:\\work\\api-server', state: 'waiting', updatedAt: Date.now() - 60000, mine: true, line: 'Wants to run npm run migrate',
      pending: [{ id: 'r1', kind: 'command', command: 'npm run migrate', raw: 'npm run migrate', folder: 'C:\\work\\api-server', offersAlways: true, always: 'Always allow commands that start with npm run' }],
      log: [{ id: 1, at: ago(180), kind: 'you', text: 'Add a status column to the orders table.' }, { id: 2, at: ago(172), kind: 'agent', text: 'I will add the column and a migration.' }, { id: 3, at: ago(160), kind: 'command', text: 'git status', status: 'finished' }, { id: 4, at: ago(140), kind: 'files', text: 'Changed 2 files: src/db/orders.ts, migrations/004.sql', paths: ['src/db/orders.ts', 'migrations/004.sql'] }] }),
    task('claude:s5', { title: 'Clean the build folder', folder: 'C:\\work\\website', state: 'waiting', updatedAt: Date.now() - 120000, mine: true, line: 'Wants to run rm -rf build',
      pending: [{ id: 'r2', kind: 'command', command: 'rm -rf build', raw: 'rm -rf build', folder: 'C:\\work\\website', offersAlways: true, always: 'Always allow this command in website', danger: 'It deletes files or folders for good.' }],
      log: [{ id: 5, at: ago(130), kind: 'you', text: 'Clean up the build folder.' }, { id: 6, at: ago(124), kind: 'asked', text: 'rm -rf build' }] }),
    task('claude:s2', { title: 'Rebuild the pricing page', folder: 'C:\\work\\website', state: 'working', mine: true, line: 'Running npm test',
      log: [{ id: 7, at: ago(48), kind: 'you', text: 'Rebuild the pricing page with two plans.' }, { id: 8, at: ago(41), kind: 'agent', text: '**Two plans** it is. I will start with the table.' }, { id: 9, at: ago(12), kind: 'command', text: 'npm test', status: 'running' }] }),
    task('claude:s4', { title: 'Write the release notes', folder: 'C:\\work\\notes', state: 'working', pid: 4242, line: 'Working in its own window' }),
    // A task Togle does not run, with its conversation as its agent keeps it: the last turns, and the turns before (`older`).
    task('claude:s3', { title: 'Fix the login redirect', folder: 'C:\\work\\website', updatedAt: Date.now() - 5 * hour, history: {
      older: [{ id: 21, at: ago(5 * 3600 + 1200), kind: 'you', text: 'Where does the login redirect go wrong?' }, { id: 22, at: ago(5 * 3600 + 1180), kind: 'agent', text: 'It drops the `next` parameter.' }],
      entries: [{ id: 23, at: ago(5 * 3600 + 600), kind: 'you', text: 'Fix it, and keep the tests green.' }, { id: 24, at: ago(5 * 3600 + 592), kind: 'agent', text: 'I will change `redirect.ts`.' }, { id: 25, at: ago(5 * 3600 + 570), kind: 'command', text: 'npm test', status: 'failed' }, { id: 26, at: ago(5 * 3600 + 530), kind: 'files', text: 'Changed 1 file: src/redirect.ts', paths: ['src/redirect.ts'], more: 'f26' }, { id: 27, at: ago(5 * 3600 + 500), kind: 'command', text: 'npm test', status: 'finished' }, { id: 28, at: ago(5 * 3600 + 466), kind: 'agent', text: 'Fixed: the redirect keeps `next`. Tests pass.' }],
      details: { 'f26#0': '@@ -10,4 +10,4 @@\n export function redirect(query) {\n-  const next = undefined\n+  const next = query.next\n   return next ?? \'/\'\n }' }
    } }),
    task('codex:t9', { title: 'Port the settings screen', folder: 'C:\\work\\mobile-app', updatedAt: Date.now() - 72 * hour })
  ]
  const runnerView = ({ log, history, ...view }) => view
  const runnerFind = key => { const found = runnerTasks.find(item => item.key === key); if (!found) throw new Error('That task is gone.'); return found }
  const runnerRank = item => item.state === 'waiting' ? 0 : item.state === 'working' ? 1 : 2
  const runnerChanged = () => emit('onRunnersChanged')
  // The task the window has on screen: one that finished is not new once seen, as main has it (titles.ts).
  let onScreen = null
  api.taskOnScreen = key => {
    record('taskOnScreen', [key])
    onScreen = key
    const found = key && runnerTasks.find(item => item.key === key)
    if (found?.fresh) { found.fresh = false; runnerChanged() }
  }
  // The person's own arrangement of the list, in memory, changed as main changes it (task-groups.ts, in short).
  let groups = clone(fixture.groups ?? { made: [], names: {}, placed: {}, folded: [] })
  groups.earlierFolded ??= clone(groups.folded)
  api.taskGroups = async () => clone(groups)
  api.changeTaskGroups = async change => {
    record('changeTaskGroups', [change])
    const next = clone(groups)
    const made = key => next.made.some(group => 'made:' + group.id === key)
    if (change.kind === 'make' && change.name.trim() && !next.made.some(group => group.id === change.id)) next.made.push({ id: change.id, name: change.name.trim() })
    else if (change.kind === 'rename' && change.group.startsWith('made:')) { const group = next.made.find(item => 'made:' + item.id === change.group); if (group && change.name.trim()) group.name = change.name.trim() }
    else if (change.kind === 'rename') { if (change.name.trim()) next.names[change.group] = change.name.trim(); else delete next.names[change.group] }
    else if (change.kind === 'remove' && made(change.group)) { next.made = next.made.filter(group => 'made:' + group.id !== change.group); for (const [task, at] of Object.entries(next.placed)) if (at.group === change.group) delete next.placed[task]; for (const key of ['folded', 'earlierFolded']) next[key] = next[key].filter(at => at.group !== change.group) }
    else if (change.kind === 'place' && change.group !== 'scheduled' && (!change.group.startsWith('made:') || made(change.group))) next.placed[change.task] = change.subject ? { group: change.group, subject: change.subject } : { group: change.group }
    else if (change.kind === 'put-back') delete next.placed[change.task]
    else if (change.kind === 'fold-subject') {
      const key = change.earlier ? 'earlierFolded' : 'folded'
      next[key] = next[key].filter(at => !(at.group === change.group && at.subject.toLowerCase() === change.subject.toLowerCase()))
      if (change.folded) next[key].push({ group: change.group, subject: change.subject })
    }
    groups = next
    return clone(groups)
  }
  // Agents added in Settings, in memory: any that speaks ACP, by name and command.
  const addedAgents = []
  // Agents Togle finds by itself that were taken off its lists (Remove): listed as removed, so that they can be added back.
  const removedKnown = new Set()
  // (`fixture.agentsFound`: a scenario that has none by default, given them: a call with an agent to start for it.)
  const knownAgents = () => (['tasks', 'confirm-names'].includes(fixture.scenario) || fixture.agentsFound ? [{ runner: 'claude', name: 'Claude Code', installed: true, version: '2.1.322' }, { runner: 'codex', name: 'Codex', installed: true, version: '0.166.0' }, { runner: 'hermes', name: 'Hermes', installed: !!fixture.hermesMeters }] : []).map(agent => removedKnown.has(agent.runner) ? { runner: agent.runner, name: agent.name, installed: false, removed: true } : agent)
  api.runnerStatus = async () => [...knownAgents(), ...clone(addedAgents)]
  api.attachmentPath = file => webUtils.getPathForFile(file)
  api.showChatFile = async href => { record('showChatFile', [href]); return !href.endsWith('/missing.log') }
  let extraTokens = 0
  const reportedCosts = new Map()
  const codexWindows = [{ label: 'weekly', usedPercent: 17, resetsAt: Date.now() + 101 * hour }]
  api.runnerLimits = async runner => {
    record('runnerLimits', [runner])
    if (runner === 'hermes' && fixture.hermesMeters) return [{ ...codexWindows[0], provider: 'ChatGPT' }]
    return runner === 'codex' ? clone(codexWindows) : []
  }
  api.runnerUsage = async (runner, id) => {
    record('runnerUsage', [runner, id ?? null])
    if (runner === 'hermes' && fixture.hermesMeters) return { kind: 'providers', period: id ? 'session' : 'all', sources: [
      { provider: 'ChatGPT', billing: 'subscription', tokens: id ? 700 : 3400 },
      { provider: 'Kimi', billing: 'api', tokens: id ? 300 : 1700, cost: { currency: 'USD', amount: id ? 0.20 : 1.10 }, estimated: true }
    ] }
    if (reportedCosts.has(runner)) return { kind: 'cost', scope: id ? 'session' : 'agent-sessions', amounts: [{ amount: reportedCosts.get(runner), currency: 'USD' }] }
    return runner === 'codex' ? id ? { kind: 'tokens', period: 'session', total: (id === 'installer-link' ? 12400 : 5700) + extraTokens }
      : { kind: 'tokens', period: '7d', total: 89000 + extraTokens }
    : runner === 'claude' ? { kind: 'cost', scope: id ? 'session' : 'api-tasks', amounts: [{ amount: id ? 0.08 : 1.25, currency: 'USD' }] }
      : { kind: 'unavailable', reason: 'unsupported' }
  }
  // The main process tells how it runs from the command: one for ACP is talked to, any other runs in a terminal (here: with acp in it, and no {task}).
  const acpCommand = command => !command.includes('{task}') && /(^|[^a-z])acp([^a-z]|$)/i.test(command)
  api.addCodingAgent = async (name, command) => { record('addCodingAgent', [name, command]); addedAgents.push({ runner: (acpCommand(command) ? 'acp-' : 'term-') + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, installed: true, added: true, command }); return api.runnerStatus() }
  // Edit: an added agent's command. How it runs stays: a command that would run it the other way is refused, as the main process does.
  api.editCodingAgent = async (id, command) => {
    record('editCodingAgent', [id, command])
    const agent = addedAgents.find(item => item.runner === id)
    if (!agent) throw new Error('That agent was not added in Togle.')
    if (acpCommand(command) !== id.startsWith('acp-')) throw new Error(`With that command ${agent.name} would be ${acpCommand(command) ? 'a conversation, not a terminal' : 'a terminal, not a conversation'}. Remove it and add it again with that command.`)
    agent.command = command
    return api.runnerStatus()
  }
  // What Add another agent lists: some found here, more from the registry (that start through npx), or none of the more when offline.
  api.agentCatalog = async () => {
    record('agentCatalog', [])
    const taken = name => addedAgents.some(agent => agent.name === name)
    const found = [{ id: 'gemini', name: 'Gemini CLI', description: 'Google\'s official CLI for Gemini', command: 'gemini --acp' }, { id: 'aider', name: 'Aider', description: 'AI pair programming in your terminal', command: 'aider' }]
    const more = [{ id: 'goose', name: 'goose', description: 'A local, extensible, open source AI agent', command: 'npx -y goose-acp@1.0.0' }, { id: 'opencode', name: 'OpenCode', description: 'The open source coding agent', command: 'npx -y opencode-ai@1.0.0 acp' }, { id: 'mistral-vibe', name: 'Mistral Vibe', description: 'Mistral\'s coding agent', command: 'uvx mistral-vibe --acp', needs: 'uvx' }]
    // (`fixture.catalogMany`: the registry's real length, a few dozen, so that its list has to scroll.)
    const extra = fixture.catalogMany ? Array.from({ length: 24 }, (_, n) => ({ id: 'extra-' + n, name: 'Extra agent ' + (n + 1), description: 'One more agent of the list, with a line about it that is long enough to be cut off at the end of its row', command: 'npx -y extra-acp-' + n + '@1.0.0' })) : []
    return clone({ found: (fixture.catalog?.found ?? found).filter(choice => !taken(choice.name)), more: fixture.catalogOffline ? [] : [...(fixture.catalog?.more ?? more), ...extra].filter(choice => !taken(choice.name)), registry: !fixture.catalogOffline })
  }
  api.removeCodingAgent = async id => { record('removeCodingAgent', [id]); if (['claude', 'codex', 'hermes'].includes(id)) removedKnown.add(id); else addedAgents.splice(addedAgents.findIndex(agent => agent.runner === id), 1); return api.runnerStatus() }
  api.restoreCodingAgent = async id => { record('restoreCodingAgent', [id]); removedKnown.delete(id); return api.runnerStatus() }
  // Reach (Togle Studio), when a check asks for it: this computer, a MacBook and a server whose task waits on a command.
  if (fixture.reach) {
    let reach = {
      available: true, link: 'member', connection: 'on', standing: 'member', me: { device: 'pc', name: 'Windows PC', role: 'computer' },
      devices: [
        { device: 'pc', name: 'Windows PC', role: 'computer', me: true, online: true },
        { device: 'mac', name: 'MacBook', role: 'computer', me: false, online: true },
        { device: 'srv', name: 'build-server', role: 'server', me: false, online: true }
      ],
      actOnThis: true,
      acted: [{ at: Date.UTC(2026, 10, 13, 9, 12), device: 'mac', name: 'MacBook', what: 'Stopped Write the release notes' }]
    }
    const remote = [{ device: 'srv', name: 'build-server', role: 'server', online: true, at: Date.now(), tasks: [
      { key: 'codex:apply', title: 'Apply the staging plan', agent: 'Codex', folder: 'infra', state: 'waiting', line: 'The plan is ready. 3 resources change and none are destroyed.', pending: [{ id: 'r1', kind: 'command', command: 'terraform apply -var-file=staging.tfvars', danger: 'It changes what runs in a live environment.' }], mine: true, commandsRunning: false, updatedAt: Date.now() },
      { key: 'hermes:report', title: 'Write the nightly report', agent: 'Hermes', folder: 'reports', state: 'working', line: 'Reading the logs', pending: [], mine: true, commandsRunning: false, updatedAt: Date.now() }
    ] }]
    const reachChanged = () => emit('onReachChanged')
    api.reachState = async () => clone(reach)
    api.reachRemoteTasks = async () => clone(remote)
    api.reachAct = async (device, act) => {
      record('reachAct', [device, act])
      const task = remote[0].tasks.find(item => item.key === act.task)
      if (act.what === 'refuse') task.pending = task.pending.filter(item => item.id !== act.request)
      if (act.what === 'stop') task.state = 'stopped'
      reachChanged()
    }
    api.reachAdd = async code => { record('reachAdd', [code]); reach = { ...reach, adding: { stage: 'confirm', name: 'gpu-box', role: 'server' } }; reachChanged(); return clone(reach) }
    api.reachConfirmAdd = async () => { record('reachConfirmAdd', []); reach = { ...reach, adding: { stage: 'added', name: 'gpu-box', role: 'server' }, devices: [...reach.devices, { device: 'gpu', name: 'gpu-box', role: 'server', me: false, online: true }] }; reachChanged(); return clone(reach) }
    api.reachRemove = async device => { record('reachRemove', [device]); reach = { ...reach, devices: reach.devices.filter(item => item.device !== device) }; reachChanged(); return clone(reach) }
    api.reachActOnThis = async on => { record('reachActOnThis', [on]); reach = { ...reach, actOnThis: on }; reachChanged(); return clone(reach) }
  }
  api.runnerTasks = async () => clone(runnerTasks.map(runnerView)).sort((a, b) => runnerRank(a) - runnerRank(b) || b.updatedAt - a.updatedAt)
  api.runnerDetail = async key => { const found = runnerFind(key); return clone({ task: runnerView(found), log: found.log }) }
  // A conversation as its agent keeps it: a task given `history` has it (its last turns, and with `all` the older ones too); any other has none to read.
  api.runnerHistory = async (key, all) => {
    record('runnerHistory', [key, all === true])
    const found = runnerFind(key)
    if (!found.history) return null
    return clone({ entries: all && found.history.older ? [...found.history.older, ...found.history.entries] : found.history.entries, more: !!found.history.older && all !== true, ...(found.history.queued?.length ? { queued: found.history.queued } : {}), ...(found.history.questions ? { questions: found.history.questions } : {}) })
  }
  // What a step holds (what a command printed, a thought's words), as a task given `history.details` keeps it by the step's key.
  api.runnerStep = async (key, more) => {
    record('runnerStep', [key, more])
    const text = runnerFind(key).history?.details?.[more]
    return typeof text === 'string' ? clone({ text, cut: text.length > 24000 }) : null
  }
  let failTask = false
  // An agent that wants the person signed in first (Cline): it refuses a task, and offers its ways of signing in, until one is used.
  let signIn = null, signInFails = false
  api.agentSignInChoices = async runner => (signIn && signIn.runner === runner ? clone(signIn.choices) : [])
  api.signInAgent = async (runner, method) => {
    record('signInAgent', [runner, method])
    if (!signIn || signIn.runner !== runner || !signIn.choices.some(choice => choice.id === method)) throw new Error('No such way to sign in.')
    if (signInFails) throw new Error('Sign-in was cancelled')
    signIn = null
  }
  api.startRunnerTask = async request => {
    record('startRunnerTask', [request])
    if (signIn && signIn.runner === request.runner) throw new Error(signIn.name + ' needs you to sign in first.')
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
  // A task in the background has the agent's own screen: opening a task whose screen is closed opens it again, a new screen.
  api.openRunnerTask = async key => {
    record('openRunnerTask', [key]); const found = runnerFind(key); found.mine = true
    if (found.screen && !found.terminal) {
      found.terminal = true; found.screenId = '3f2a9c1e-' + ++found.screens; delete found.screenClosed
      const printed = 'Claude Code v2.1.323\r\n> '
      terminals.set(key, { text: printed, end: printed.length })
    }
    runnerChanged(); return clone(runnerView(found))
  }
  // Take over moves the conversation into the background and makes the agent's own screen in Togle: a terminal Togle also hears,
  // that waits for a message. Hand back closes the screen: the task goes on.
  api.takeOverRunnerTask = async key => {
    record('takeOverRunnerTask', [key]); const found = runnerFind(key)
    Object.assign(found, { mine: true, terminal: true, screen: true, job: '3f2a9c1e', screens: 1, screenId: '3f2a9c1e-1', state: 'idle', line: '' }); delete found.pid
    const printed = 'Claude Code v2.1.323\r\n> '
    terminals.set(key, { text: printed, end: printed.length }); runnerChanged(); return clone(runnerView(found))
  }
  // As main does (hub.ts sendOrHold): words for an agent written to on its screen wait while it works, and go in when its turn ends. Claude Code and
  // Hermes are typed to at once while they only work (Claude Code's own queue takes them, Hermes steers its turn with them); only a question or a
  // permission that waits on the screen holds them. (Another agent in a terminal of the person's own holds them while it works: `slow` in a task.)
  const takesNoWords = found => !!found.screen && found.runner !== 'codex' && (found.runner === 'claude' || found.runner === 'hermes' ? found.state === 'waiting' || !!found.waitingFor || (found.pending ?? []).length > 0 : found.state === 'working' || found.state === 'waiting' || !!found.waitingFor)
  const dropHeld = found => { const held = found.held ?? []; delete found.held; delete found.heldNote; delete found.heldPaused; return held }
  api.handBackRunnerTask = async key => {
    record('handBackRunnerTask', [key]); const found = runnerFind(key)
    delete found.terminal; delete found.screenId
    const held = dropHeld(found); runnerChanged()
    return { command: 'claude attach 3f2a9c1e', folder: found.folder, ...(held.length ? { held: held.join('\n\n') } : {}) }
  }
  api.sendToRunnerTask = async (key, text) => {
    record('sendToRunnerTask', [key, text]); const found = runnerFind(key)
    if (takesNoWords(found)) { found.held = [...(found.held ?? []), text]; delete found.heldNote; delete found.heldPaused; runnerChanged(); return }
    found.log.push({ id: 200 + ++sequence, at: Date.now(), kind: 'you', text }); found.state = 'working'; found.line = 'Working…'; runnerChanged()
  }
  // The model and effort a task's agent works with now (a task given `model: { model, effort }`), as main reads them from the agent's record.
  api.runnerModel = async key => { record('runnerModel', [key]); return clone(runnerFind(key).model ?? null) }
  // What waits in the agent's own queue (a task given `history.queued`), given back as main does it: its screen's Up arrow and an emptied prompt.
  // The words come back in the order they were queued, and the queue is empty.
  api.takeBackRunnerQueue = async key => {
    record('takeBackRunnerQueue', [key]); const found = runnerFind(key)
    const words = found.history?.queued ?? []
    if (found.history) { found.history = { ...found.history }; delete found.history.queued }
    runnerChanged(); return clone(words)
  }
  api.heldRunnerReply = async (key, action, index) => {
    record('heldRunnerReply', index === undefined ? [key, action] : [key, action, index]); const found = runnerFind(key)
    if (action === 'drop') {
      if (index === undefined) dropHeld(found)
      else { found.held = (found.held ?? []).filter((_, at) => at !== index); if (!found.held.length) dropHeld(found) }
      runnerChanged(); return
    }
    // An interrupt stops what the agent does first, and what is queued goes in at once.
    if (action !== 'interrupt' && takesNoWords(found)) throw new Error('Claude Code is still working. It goes in when it finishes.')
    const text = dropHeld(found).join('\n\n')
    if (!text) return
    found.pending = []
    found.log.push({ id: 200 + ++sequence, at: Date.now(), kind: 'you', text }); found.state = 'working'; found.line = 'Working…'; runnerChanged()
  }
  // An interrupt, as main does it (hub.ts interrupt): what the agent does is stopped, and these words go in at once.
  api.interruptRunnerTask = async (key, text) => {
    record('interruptRunnerTask', [key, text]); const found = runnerFind(key)
    found.pending = []
    found.log.push({ id: 200 + ++sequence, at: Date.now(), kind: 'you', text }); found.state = 'working'; found.line = 'Working…'; runnerChanged()
  }
  // A picture in a conversation: a task given `history.pictures` keeps each as a data: address by its key.
  api.runnerPicture = async (key, picture) => { record('runnerPicture', [key, picture]); return runnerFind(key).history?.pictures?.[picture] ?? null }
  api.answerRunnerTask = async (key, requestId, decision) => {
    record('answerRunnerTask', [key, requestId, decision]); const found = runnerFind(key)
    found.pending = found.pending.filter(request => request.id !== requestId)
    found.log.push({ id: 300 + ++sequence, at: Date.now(), kind: 'note', text: decision === 'refuse' ? 'You refused it.' : 'You allowed it.' })
    if (!found.pending.length) { found.state = 'working'; found.line = 'Working…' }
    runnerChanged()
  }
  api.replyRunnerTask = async (key, requestId, text) => { record('replyRunnerTask', [key, requestId, text]); runnerFind(key).pending = []; runnerChanged() }
  // What an agent offers for the reply box, in the words Claude Code 2.1.323 tells them; Codex tells none.
  api.runnerOffers = async key => {
    record('runnerOffers', [key])
    if (!key.startsWith('claude:')) return { commands: [], models: [] }
    return {
      commands: [
        { name: 'code-review', description: 'Review the current diff, or a PR number/branch/path target, for correctness bugs', hint: '[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]' },
        { name: 'supabase:supabase', description: '(supabase) Use when doing ANY task involving Supabase.' },
        { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', hint: '[name]' },
        { name: 'compact', description: 'Free up context by summarizing the conversation so far', hint: '<optional custom summarization instructions>' },
        { name: 'config', description: 'Set a setting by key', hint: 'key=value' },
        { name: 'context', description: 'Show current context usage' },
        { name: 'model', description: 'Set the AI model for Claude Code', hint: '<model>' }
      ],
      models: [
        { id: 'default', name: 'Default (recommended)', description: 'Fable 5.2' },
        { id: 'opus', name: 'Opus 5.5', description: 'For complex work and everyday tasks' },
        { id: 'fable', name: 'Fable 5.2', description: 'For your toughest challenges' },
        { id: 'sonnet', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
        { id: 'haiku', name: 'Haiku 5.5', description: 'Fastest for quick answers' }
      ]
    }
  }
  api.stopRunnerTask = async key => { record('stopRunnerTask', [key]); const found = runnerFind(key); found.state = 'stopped'; found.pending = []; found.line = ''; if (found.runner === 'codex') found.commandsRunning = true; if (found.held?.length) found.heldPaused = true; runnerChanged() }
  api.endRunnerCommands = async key => { record('endRunnerCommands', [key]); runnerFind(key).commandsRunning = false; runnerChanged(); return 1 }
  api.closeRunnerTask = async key => { record('closeRunnerTask', [key]); runnerFind(key).mine = false; runnerChanged() }
  // A task in a terminal of Togle's own: what it printed (a test adds to it with onTerminalData), and what is sent to it.
  const terminals = new Map()
  api.terminalRead = async key => { record('terminalRead', [key]); return clone(terminals.get(key) ?? { text: '', end: 0 }) }
  api.terminalWrite = async (key, data) => { record('terminalWrite', [key, data]) }
  api.terminalResize = async (key, cols, rows) => { record('terminalResize', [key, cols, rows]) }
  // A picture pasted into a terminal: kept where main keeps one (pasted-pictures.ts), here only by name. A type that is no picture fails as main's does.
  api.savePastedPicture = async (bytes, type) => {
    record('savePastedPicture', [bytes?.length ?? 0, type])
    if (!/^image\//.test(type)) throw new Error('That is not a picture Togle can paste.')
    return 'C:\\Users\\someone\\AppData\\Roaming\\Togle\\pasted\\paste-20261118-120000.png'
  }
  // A picture kept that way, read back: a small one for any file, and none for a file named "gone" (a week has passed).
  api.pastedPicture = async file => { record('pastedPicture', [file]); return /gone/.test(file) ? null : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' }
  api.typeTerminalWords = async key => { record('typeTerminalWords', [key]); delete runnerFind(key).words; runnerChanged() }
  // The window's own buttons: maximized or not, as main tells it.
  let maximized = false
  api.isMaximized = async () => maximized
  api.maximize = () => { record('maximize', []); maximized = !maximized; emit('onMaximized', maximized) }
  api.pickRunnerFolder = async () => { record('pickRunnerFolder', []); return 'C:\\work\\picked' }
  api.pickTaskBoxFolder = async () => { record('pickTaskBoxFolder', []); return 'C:\\work\\chosen-for-box' }
  api.openTaskBox = async opening => { record('openTaskBox', [opening]) }
  // What the box was opened with before its page listened (its first opening), when a test gives it one.
  api.taskBoxOpening = async () => clone(fixture.taskBoxOpening ?? null)
  // What the corner notices showed before their pages listened, when a test gives it.
  api.callNoticeNow = async () => { record('callNoticeNow', []); return clone(fixture.callNoticeNow ?? null) }
  api.keysNoticeNow = async () => { record('keysNoticeNow', []); return clone(fixture.keysNoticeNow ?? null) }
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
  api.clearTodos = async refs => {
    refs.forEach(todoAt)
    for (const line of refs.map(ref => ref.line).sort((a,b) => b-a)) todoItems.splice(line, 1)
    emit('onTodoChanged')
    return clone(todoView())
  }
  const reviewedTodos = new Set()
  api.reviewMeetingTodo = async (call, text, action) => {
    record('reviewMeetingTodo', [call, text, action])
    const key = JSON.stringify([call, text])
    if (!reviewedTodos.has(key) && action === 'add') todoItems.push({ text: text.replace(/\.$/, ''), done: false })
    reviewedTodos.add(key)
    emit('onTodoChanged')
    return clone(todoView())
  }
  api.meetingOffers = async callId => {
    const offers = fixture.scenario === 'tasks' ? {
      calls: [{ id: 'sprint', title: 'Sprint review', startedAt: Date.now() - 3600_000, notes: true, toConfirm: 2 }, { id: 'planning', title: 'Planning sync', startedAt: Date.now() - 7200_000, notes: true, toConfirm: 0 }],
      items: [{ callId: 'planning', title: 'Planning sync', startedAt: Date.now() - 7200_000, text: 'Send the API timeline to Dario.' }, { callId: 'planning', title: 'Planning sync', startedAt: Date.now() - 7200_000, text: 'Book the staging review.' }]
    } : { calls: [], items: [] }
    const meeting = sessions.find(call => call.id === callId)
    if (meeting?.title === 'Acme renewal') offers.items = ['Send the report.', 'Book the review.'].map(text => ({ callId, title: meeting.title, startedAt: meeting.startedAt, text }))
    offers.items = offers.items.filter(item => (!callId || callId === item.callId) && !reviewedTodos.has(JSON.stringify([item.callId, item.text])))
    return clone(offers)
  }
  api.linkTodo = async (ref, task) => { record('linkTodo', [ref, task]); const item = todoAt(ref); if (task) item.task = task; else delete item.task; return clone(todoView()) }
  api.showTodoFile = async () => { record('showTodoFile', []) }
  // F8 Show's overlay: the frozen screen it shows, and the picture it gives back (its first bytes and its size, from the
  // PNG's header).
  api.showPicture = async () => fixture.showPicture ?? null
  api.showDone = png => { const view = new DataView(png.buffer, png.byteOffset, png.byteLength); record('showDone', [{ head: [...png.slice(0, 8)], width: view.getUint32(16), height: view.getUint32(20), png: Buffer.from(png).toString('base64') }]) }
  api.showCancel = () => { record('showCancel', []) }
  // How long main takes to answer, per call, in milliseconds (`fixture.slow`, or later togleUITest.slow), and a call that fails
  // once (togleUITest.failNext): the waits of the real app, made visible. A call neither slowed nor failing answers as before.
  const slow = { ...(fixture.slow ?? {}) }
  const failOnce = new Set()
  for (const name of Object.keys(api)) {
    const answer = api[name]
    if (typeof answer !== 'function' || name.startsWith('on')) continue
    api[name] = (...args) => {
      if (!slow[name] && !failOnce.has(name)) return answer(...args)
      const failing = failOnce.delete(name)
      return new Promise((resolve, reject) => setTimeout(() => {
        if (failing) return reject(new Error('It did not answer.'))
        try { Promise.resolve(answer(...args)).then(resolve, reject) } catch (error) { reject(error) }
      }, slow[name] ?? 0))
    }
  }
  contextBridge.exposeInMainWorld('togle', api)
  // A noisy call's measurement, as the capture's noise check reports it when the call ends (the audio here is silent).
  const noiseReport = () => ({ analyzedMs: 600000, speechMs: 180000, quietMs: 360000, noisyMs: 162000, bursts: 41, floorDb: -47, peakDb: -38, speechDb: -24, snrDb: 23, verdict: 'noisy', sample: new Float32Array(1600) })
  contextBridge.exposeInMainWorld('togleDev', { silentAudio: !['audio', 'start-failure'].includes(fixture.scenario), ...(fixture.scenario === 'noisy-call' ? { noiseReport } : {}) })
  contextBridge.exposeInMainWorld('togleUITest', {
    setExtraTokens: n => { extraTokens = n },
    changeNativeSession: (key, id) => { runnerFind(key).sessionId = id; runnerChanged() },
    publishWeeklyLimit: n => { codexWindows[0].usedPercent = n; emit('onRunnerLimitsChanged', { runner: 'codex', windows: clone(codexWindows) }) },
    setReportedCost: (runner, amount) => { reportedCosts.set(runner, amount) },
    // A session that runs in a terminal asks about a command and the question is held here: it waits, and can be answered.
    // An agent answers a question put to it on a call: the question as it was sent (with where the call is saved), and its words after.
    answerOnCall: (key, question, answer) => {
      const found = runnerFind(key)
      found.history = { entries: [{ id: 400 + ++sequence, at: Date.now(), kind: 'you', text: question + '\n\nA call is saved at "C:\\calls\\live.md".' }, { id: 400 + ++sequence, at: Date.now(), kind: 'agent', text: answer }] }
      found.state = 'idle'; runnerChanged()
    },
    // An agent's own record of a task gains entries (what was said to it, what it did), as it does a moment after a reply is sent.
    // An entry with an id the record already has takes its place (a command that ended).
    recorded: (key, entries) => {
      const found = runnerFind(key), kept = [...(found.history?.entries ?? [])]
      for (const entry of clone(entries)) { const at = kept.findIndex(one => one.id === entry.id); if (at < 0) kept.push(entry); else kept[at] = entry }
      found.history = { ...found.history, entries: kept }; found.updatedAt = Date.now(); runnerChanged()
    },
    askOutside: (key, request) => { const found = runnerFind(key); found.pending = [clone(request)]; found.state = 'waiting'; found.line = 'Wants to run ' + (request.command ?? ''); runnerChanged() },
    // A task of an agent without ACP, in a terminal of Togle's own that has printed `printed` so far.
    terminalTask: (props, printed) => { const added = task(props.key, { mine: true, state: 'working', terminal: true, line: 'Working…', ...props }); runnerTasks.push(added); terminals.set(added.key, { text: printed, end: printed.length }); runnerChanged() },
    // A task Togle runs stops: by the person's Stop, or by itself (an error, or its agent signed out: `extra`).
    stopTask: (key, state, line, extra) => { const found = runnerFind(key); found.state = state; found.line = line; found.pending = []; Object.assign(found, extra ?? {}); runnerChanged() },
    // A task changes by itself: its subject given, it finishes and is new (unless it is on screen), it is touched.
    setTask: (key, props) => { const found = runnerFind(key); Object.assign(found, clone(props)); if (found.fresh && found.key === onScreen) found.fresh = false; runnerChanged() },
    // A task that cannot be sent a call: what giving it the call answers.
    giveFails: (key, problem) => { fixture.giveFails = { ...(fixture.giveFails ?? {}), [key]: problem } },
    // Agents found on this computer, in a scenario that has none by default (Claude Code and Codex).
    agentsFound: on => { fixture.agentsFound = on },
    // The registry of more agents cannot be reached (no connection): Add another agent lists only what is found here.
    catalogOffline: on => { fixture.catalogOffline = on },
    catalogMany: on => { fixture.catalogMany = on },
    // What the window is told of Claude Code's connection to Togle, changed by hand.
    failNextTask: () => { failTask = true },
    signInNeeded: (runner, name, choices) => { signIn = { runner, name, choices: clone(choices) } },
    signInFails: on => { signInFails = on },
    microphone: status => { microphone = clone(status); microphoneChanged() },
    failNextShowMicrophone: message => { showFails = message },
    calls: () => clone(calls), emit, settings: () => clone(fixture.settings),
    failNextAuto: () => { rejectAuto = true }, failNextSettings: () => { rejectSettings = true }, holdNextClear: () => { holdClear = true }, releaseClear: () => { holdClear = false; releaseClear?.() },
    failNextVocabulary: () => { rejectVocabulary = true },
    failNextHistory: () => { rejectHistory = true }, failNextNotes: () => { rejectNotes = true },
    slow: (name, ms) => { if (ms) slow[name] = ms; else delete slow[name] }, failNext: name => { failOnce.add(name) },
    dictationEntry: (id, text) => { const history = historyOf(id); if (!history.enabled) return; history.entries.unshift({ id: 'dictation-' + ++sequence, revision: 'entry-' + sequence, text, originalText: text, startedAt: Date.now() - 3000, finishedAt: Date.now(), destination: 'Slack', outcome: 'inserted' }); histories.set(id, history) },
    notesChanged: (id, text) => { const session = needSession(id); session.summary = text; session.minutes = { state: 'ready', template: 'concise', revision: 'remote-' + ++sequence }; emit('onCallSessions', { id }) }
  })
}
