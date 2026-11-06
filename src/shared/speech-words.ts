export interface SpeechWord { id: string; heardAs: string; word: string }

const key = (text: string): string => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const unquote = (text: string): string => text.trim().replace(/^["“'‘]|["”'’]$/gu, '').trim()

/** Plain vocabulary remains valid. Explicit agent corrections occupy their own readable lines. */
export function speechWords(vocabulary = ''): SpeechWord[] {
  const words = new Map<string, SpeechWord>()
  for (const line of vocabulary.split(/\r?\n/)) {
    const match = /^(.+?)\s*(?:=>|→)\s*(.+)$/.exec(line.trim())
    if (!match) continue
    const heardAs = unquote(match[1]), word = unquote(match[2])
    if (!heardAs || !word || heardAs.length > 80 || word.length > 80 || /[\x00-\x1f]/u.test(heardAs + word)) continue
    words.set(key(heardAs), { id: `agent-word-${key(heardAs)}`, heardAs, word })
  }
  return [...words.values()]
}

export function withSpeechWord(vocabulary: string, heard: string, written: string): string {
  const heardAs = unquote(heard), word = unquote(written)
  if (!heardAs || !word || heardAs.length > 80 || word.length > 80 || /[\x00-\x1f]|=>|→/u.test(heardAs + word)) throw new Error('Give a short spoken phrase and its correct spelling, up to 80 characters each.')
  const lines = vocabulary.split(/\r?\n/).filter(line => {
    const match = /^(.+?)\s*(?:=>|→)\s*(.+)$/.exec(line.trim())
    return !match || key(unquote(match[1])) !== key(heardAs)
  }).filter(line => line.trim())
  return [...lines, `${heardAs} → ${word}`].join('\n')
}

export function vocabularyTerms(vocabulary: string): string[] {
  return [...new Set([...speechWords(vocabulary).reverse().map(item => item.word), ...vocabulary.split(/\r?\n/).flatMap(line => {
    const mapped = speechWords(line)
    return mapped.length ? mapped.map(item => item.word) : line.split(',').map(term => term.trim()).filter(Boolean)
  })])]
}

/** Only an explicit first-person wording lesson is eligible for immediate, deterministic learning. */
export function speechLesson(text: string): { heardAs: string; word: string } | undefined {
  const match = /^\s*(?:remember[, :]*)?when I say\s+(.+?)\s*(?:,\s*)?(?:it means|I mean|that means|write|spell(?: it)? as)\s+(.+?)\s*[.!]?\s*$/iu.exec(text)
  if (!match) return
  const heardAs = unquote(match[1].replace(/,\s*$/, '')), word = unquote(match[2].replace(/[.!]$/, ''))
  if (!heardAs || !word || heardAs.length > 80 || word.length > 80 || heardAs.split(/\s+/).length > 6 || word.split(/\s+/).length > 6) return
  const numbers: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
  return { heardAs, word: /\b[A-Z]{2,}\b/u.test(word) ? word.replace(/\bnumber (zero|one|two|three|four|five|six|seven|eight|nine)\b/giu, (_all, n: string) => numbers[n.toLowerCase()]) : word }
}

/** Longest-first whole phrases; never rewrite a substring or apply replacement chains. */
export function correctSpeech(text: string, words: SpeechWord[]): string {
  if (!words.length) return text
  const unique = new Map(words.map(word => [key(word.heardAs), word]))
  const ordered = [...unique.values()].sort((a, b) => b.heardAs.length - a.heardAs.length)
  const escaped = ordered.map(word => word.heardAs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  const boundary = '[\\p{L}\\p{N}\\p{M}_]'
  return text.normalize('NFC').replace(new RegExp(`(?<!${boundary})(?:${escaped.join('|')})(?!${boundary})`, 'giu'), phrase => {
    // Unicode case folding can match final sigma/long s even when lowercase map keys differ.
    return unique.get(key(phrase))?.word ?? ordered[escaped.findIndex(pattern => new RegExp(`^(?:${pattern})$`, 'iu').test(phrase))]?.word ?? phrase
  })
}
