import type { Settings, TranscriptEntry } from './types'

export const NOTES_ACCOUNT_UNAVAILABLE = 'The account saved for these meeting notes is unavailable.'

/** Older saved notes contain the account service's error verbatim. */
export function missingNotesAccount(message: string): boolean {
  return message === NOTES_ACCOUNT_UNAVAILABLE || message.startsWith('This subscription account is unavailable.') || message.startsWith('This AI connection is unavailable.')
}

/**
 * What the person can tell the others on a call, so they know it is being written down: true for how this computer
 * hears it. With the speech models on this computer the sound never leaves it; with a speech service it goes there.
 */
export function tellOthersLine(transcription: Pick<Settings['transcription'], 'me' | 'them'>): string {
  const here = transcription.me === 'local' && transcription.them === 'local'
  // The design's words: what is done with the sound. The person was told when the first call started where the words go.
  return `I'm writing this call down with Togle. ${here ? 'The sound stays on my computer.' : 'The sound is sent to a speech service to turn it into text.'}`
}

/** A prompt to check group mode, never a claim to count voices from text. */
export function groupCue(lines: TranscriptEntry[]): boolean {
  return lines.slice(-30).some(line => /\b(?:hi|hello|welcome|thanks|thank you|good morning|good afternoon)[, ]+(?:everyone|everybody|team)\b|\b(?:let['’]s go|going) around (?:the room|for updates)\b|\b(?:both|all three|all four) of you\b/i.test(line.text))
}

/** Only explicit introductions nominate a name. Names mentioned in a question belong to its addressee. */
export function introducedName(text: string): string | undefined {
  const match = /(?:^|[.!?]\s+)(?:(?:hi|hello|hey)[,!.]?\s+)?(?:my name is|this is|it['’]s|i am|i['’]m)\s+([\p{L}][\p{L}'’\-]{1,30})(?=\s|[,.!?]|$)/iu.exec(text)
  const name = match?.[1]
  // Dictation often preserves proper-name capitals. Generic "I'm ready" is not an introduction.
  if (name && !/my name is/i.test(match![0]) && !/^\p{Lu}/u.test(name)) return
  if (!name || /^(?:Sorry|Happy|Here|Ready|Going|Working|Calling|Speaking|Not|The|Just|Really|Actually|Sure|Thanks|Fine|Good|Back|Done|Looking|Excited|Checking|Presenting|Important|Interesting|Clear|True|False|Wrong|Right|Possible|Only|Also|About|On|In|At|From|Still|Having|Trying)$/i.test(name)) return
  return name[0].toLocaleUpperCase() + name.slice(1)
}

export function speakerLabel(line: Pick<TranscriptEntry, 'speaker' | 'voiceId' | 'voiceName' | 'voiceNamedBy'>): string {
  return line.voiceName ? `${line.voiceName}${line.voiceNamedBy === 'suggested' ? '?' : ''}` : line.speaker === 'me' ? 'You' : line.voiceId ? `Voice ${line.voiceId.split(':').at(-1)}` : 'Call'
}

/** A mark names the line being said, or the last one finished just before: nothing said for this long before it names none. */
const MARK_REACH_MS = 45_000

/** The ids of the lines the person marked: for each mark, the last line that began before it, if it was recent. */
export function markedLineIds(record: { transcript: TranscriptEntry[]; marks?: number[] }): Set<string> {
  const marked = new Set<string>()
  for (const mark of record.marks ?? []) {
    let found: TranscriptEntry | undefined
    for (const line of record.transcript) if (line.at <= mark && (!found || line.at >= found.at)) found = line
    if (found && mark - found.end <= MARK_REACH_MS) marked.add(found.id)
  }
  return marked
}

