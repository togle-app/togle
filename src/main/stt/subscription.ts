import { speechLanguageProblem } from '@shared/speech'
import type { AccountRuntime } from '../auth/accounts'
import type { ClaudeSpeech } from './claude-speech'
import { SpeechApi } from './speech-api'

/** Both recording modes use the same account-backed recognizers, without API-key fallback. */
export function subscriptionRecognizer(entry: AccountRuntime, claude: () => ClaudeSpeech, identity = entry.auth.identity(), language: () => string): SpeechApi {
  const valid = (): boolean => (entry.kind === 'claude' ? entry.auth.cachedStatus().signedIn : entry.auth.status().signedIn) && entry.auth.identity() === identity
  const check = (): void => { if (!valid()) throw new Error('The speech account changed. Start a new call or dictation with the intended account.') }
  // Sign in with ChatGPT doesn't include transcription: a ChatGPT account's speech is heard by this PC instead.
  if (entry.kind === 'chatgpt') return new SpeechApi('chatgpt', '', () => ({ baseUrl: '', model: '' }), {
    // Signed in or not, what it needs is this PC's recognition: it never hears anything itself.
    signedIn: () => true,
    missing: () => "this PC's speech recognition (ChatGPT sign-in doesn't include transcription)",
    recognize: async () => { throw new Error("ChatGPT sign-in doesn't include transcription. Togle hears ChatGPT accounts' speech on this PC.") }
  })
  return new SpeechApi('claude', '', () => ({ baseUrl: 'https://api.anthropic.com', model: '' }), {
    signedIn: valid,
    missing: () => speechLanguageProblem('claude', language()) ? 'a supported Claude speech language' : null,
    recognize: async (pcm, options) => {
      check()
      const status = await entry.auth.status()
      check()
      if (!status.email) throw new Error('Sign in to Claude in Settings before using speech.')
      const recognize = await claude().prepare(options.language, status.email, options.signal!)
      check()
      const text = await recognize(pcm, options.signal!)
      check()
      return text
    }
  })
}
