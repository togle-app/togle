// The main-process modules the tests use, bundled into test/.build/togle.mjs.
export { asksOnly, chunkText, extractText, factsFor, listFolder, matchApproved, SearchIndex, setCodePage, setReaderScript, skillsInPlay } from '../src/main/agents/knowledge'
export { CodeBase, globTest } from '../src/main/code'
export { namesIn, ownNames, PastCalls, pastCallsText } from '../src/main/agents/past-calls'
export { AgentStore } from '../src/main/agents/store'
export { memoryForContext, memoryChars } from '../src/shared/memory'
export { speechWords, withSpeechWord, correctSpeech, speechLesson, vocabularyTerms } from '../src/shared/speech-words'
export { splitVoiceTurns, refineVoiceRegions } from '../src/main/stt/voice-audio'
export { isWorkUpdate } from '../src/main/prompts'
export { connectionSelection, connectionToolName, mayReadConnection, readTools, waitForConnections } from '../src/main/providers/claude-connections'
export { findSessions, readSession, sessionForStudy, sessionHomes, sessionInfo, withoutSecrets } from '../src/main/agents/sessions'
export { addExport, currentExports, exportAt, readChat, setChatExports } from '../src/main/agents/chat-exports'
export { entryStream, zipEntries } from '../src/main/agents/zipfile'
export { Conversations } from '../src/main/agents/conversations'
export { splitReview } from '../src/main/agents/trust'
export { readFrontMatter, writeFrontMatter } from '../src/main/agents/frontmatter'
export { scanTexts } from '../src/main/agents/guard'
export { fetchHubAgent, hubName, listHub, parseHub, publishUrl, TOGLE_HUB } from '../src/main/agents/hub'
export { Installs } from '../src/main/agents/installs'
export { packAgent, packageTexts, readPackage, slug, unzipPackage, zipPackage } from '../src/main/agents/package'
export { memoryAfter, skillAfter } from '../src/shared/memory'
export { skillPurpose, sourceLabel } from '../src/shared/agent-learning'
export { hotkeyProblem, keysPressed, sameKeys } from '../src/shared/hotkeys'
export { train } from '../src/main/agents/train'
export { ChatGPTAuth, forgetSigningKeys, verifyIdToken } from '../src/main/auth/chatgpt'
export { CallFile } from '../src/main/call-file'
export { Copilot } from '../src/main/copilot'
export { FrameStore } from '../src/main/frames'
export { hearing } from '../src/main/hearing'
export { PlanWatch, readRefusal, readStatus, windowsFromHeaders } from '../src/main/plan'
export {
  addressedTo,
  buildCallNotesPrompt,
  buildDraftPrompt,
  buildLearnPrompt,
  buildLessonPrompt,
  buildPrompt,
  buildTidyPrompt,
  buildTrainSystem,
  isSmallTalk,
  looksDeep,
  needsReply,
  parseCallRecord,
  parseDraft,
  parseLesson,
  parseLessons,
  parseTidy,
  plainAnswer,
  readFrameNote,
  suggestionsOnCall,
  talkFor,
  talkText
} from '../src/main/prompts'
export { ChatGPTProvider } from '../src/main/providers/chatgpt'
export { ClaudeProvider } from '../src/main/providers/claude'
export { ClaudeCodeAuth, claudeSubscriptionEnv, claudeCodeExecutable } from '../src/main/auth/claude-code'
export { ClaudeSubscriptionProvider } from '../src/main/providers/claude-subscription'
export { CompatProvider } from '../src/main/providers/compat'
export { captureFrame, listScreens } from '../src/main/screen'
export { getSettings, loadSettings, savedBeforeSpeechChoice, updateSettings } from '../src/main/settings'
export { reviewAfterCall, talkOf, trainHistory } from '../src/shared/chat'
export { callReadiness, workspaceEntries, CALL_NOTES_CHARS } from '../src/shared/workspace'
export { CallSessions, exportCall, legacySession, sessionSummary } from '../src/main/call-sessions'
export { CallTitles } from '../src/main/call-titles'
export { cleanCallTitle, resolveCallTitle, titleFromNotes, titleFromReview, withGeneratedTitle } from '../src/shared/call-title'
export { ScreenMonitor } from '../src/main/screen-monitor'
export { ScreenBuffer } from '../src/main/screen-buffer'
export { screenQuestionTime, screenReference, screenRange, SCREEN_SAMPLE_MS, SCREEN_HISTORY_MS } from '../src/shared/screen-time'
export { CallLearning } from '../src/main/call-learning'
export { groupCue, introducedName, calendarMeetings, dueMeeting, meetingForCall } from '../src/shared/meeting'
export { VoiceClusters, voiceSimilarity } from '../src/main/stt/voice-clusters'
export { VoiceTracker, VOICE_MODEL, VOICE_SEGMENTATION_MODEL } from '../src/main/stt/voices'
export { cleanVoiceAudio, normalizeVoice } from '../src/main/stt/voice-audio'
export { VoiceMemory } from '../src/main/stt/voice-memory'
export { sameSpeechTurn, speechTurns, mergeSpeakers } from '../src/shared/speakers'
export { CalendarReminders } from '../src/main/calendar'
export { Dictation } from '../src/main/dictation'
export { SubscriptionAccounts, accountChoice, defaultAccountId } from '../src/main/auth/accounts'
export { modelSourceId, sourceLanes, selectDefaultModel } from '../src/shared/model-selection'
export { effectiveAI, effectiveSettings, validateAIProfile, validatePreferences, AI_TASKS } from '../src/shared/preferences'
export { presetProfile, profileSettings, pinnedClaudeModels, PRESETS, PRESET_VERSION } from '../src/shared/ai-presets'
export { routedProvider, planFor } from '../src/main/providers/routed'
export { ApiConnections } from '../src/main/auth/api-connections'
export { AgentCalendars } from '../src/main/calendar'
export { HotkeyPress, virtualKey } from '../src/main/hotkey-press'
export { DictationSpeech, abortable } from '../src/main/dictation-speech'
export { subscriptionRecognizer } from '../src/main/stt/subscription'
export { DictationVocabularyStore, editVocabulary, prepareDictationText } from '../src/main/dictation-vocabulary'
export { DictationHistoryStore } from '../src/main/dictation-history'
export { spellingCorrection } from '../src/shared/dictation'
export { MeetingNotes, meetingNoteChunks } from '../src/main/meeting-notes'
export { SavedCallReader, savedCallContext } from '../src/main/saved-call-context'
export { ClaudeSpeechAccess, claudeSpeechStore, claudeKeychainService } from '../src/main/auth/claude-speech'
export { ClaudeSpeech, claudeSpeechPcm, claudeSpeechLanguage, CLAUDE_SPEECH_URL } from '../src/main/stt/claude-speech'
export { dictationSource } from '../src/shared/dictation'
export { CLAUDE_SPEECH_LANGUAGES, SPEECH_LANGUAGES, speechLanguageCode, speechLanguageProblem, migrateSpeechAccounts } from '../src/shared/speech'
export { DictationTargetBridge } from '../src/main/dictation-target'
export { externalUrl } from '../src/shared/links'
export { richDocument, richPreview, richText } from '../src/shared/rich-text'
export { cleanTranscript } from '../src/main/stt/whisper'
export { emptyLessons, lessonItems, lessonCount, selectLessons } from '../src/shared/learning'
export { AGENT_TEMPLATES } from '../src/main/agents/templates'
export { LocalParakeet, PARAKEET_MODEL } from '../src/main/stt/parakeet'
export { hearingStatus, keywordsOf, SpeechApi } from '../src/main/stt/speech-api'
export { download, SpeechInstaller } from '../src/main/stt/install'
export { lastPlace, keepPlace } from '../src/main/window-place'
export { MicrophoneLink } from '../src/main/microphone-link'
export { encodeLinkMessage, LinkLineReader, readLinkFile, readLinkState, isTogleMicrophoneLabel, microphonePage, MICROPHONE_LINK_API, MICROPHONE_PRODUCT, TOGLE_SITE } from '../src/shared/microphone-link'
export { describeNoise, isMicrophoneOn, noiseVerdict, readNoiseReport, shouldSuggest, MICROPHONE_DEFAULTS } from '../src/shared/microphone'
export { NoiseCheck, noisyThreshold } from '../src/renderer/src/audio/noise-check'
