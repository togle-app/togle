import { createHash, randomUUID } from 'node:crypto'
import type { DictationVocabulary, DictationVocabularyEdit } from '@shared/dictation'
import { readSecret, writeSecret } from './storage'

const empty = (): DictationVocabulary => ({ words: [], snippets: [] })
const key = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase()
const phrase = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 80 || !/[\p{L}\p{N}]/u.test(value) || /[\r\n\x00-\x1f]/u.test(value)) throw new Error('Use a word or phrase of up to 80 characters.')
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ')
}

export function editVocabulary(previous: DictationVocabulary, edit: DictationVocabularyEdit): DictationVocabulary {
  if (!edit || !['word', 'snippet', 'remove'].includes(edit.kind)) throw new Error('Choose a word or shortcut to change.')
  const next = structuredClone(previous)
  if (edit.id !== undefined && (typeof edit.id !== 'string' || ![...next.words, ...next.snippets].some(item => item.id === edit.id))) throw new Error('This entry was removed. Reopen the list.')
  if (edit.kind === 'remove') {
    if (!edit.id) throw new Error('Choose an entry to remove.')
    next.words = next.words.filter(item => item.id !== edit.id); next.snippets = next.snippets.filter(item => item.id !== edit.id)
    return next
  }
  if (edit.id && !(edit.kind === 'word' ? next.words : next.snippets).some(item => item.id === edit.id)) throw new Error('Choose the matching entry type.')
  const id = edit.id || randomUUID()
  const terms = edit.kind === 'word' ? [phrase(edit.word), edit.heardAs ? phrase(edit.heardAs) : ''] : [phrase(edit.phrase)]
  const used = [...next.words.filter(item => item.id !== id).flatMap(item => [item.word, item.heardAs]), ...next.snippets.filter(item => item.id !== id).map(item => item.phrase)].filter(Boolean).map(key)
  if (terms.filter(Boolean).some(term => used.includes(key(term)))) throw new Error('That word or phrase already exists. Edit its existing entry.')
  if (edit.kind === 'word') {
    if (!edit.id && next.words.length >= 100) throw new Error('You can save up to 100 words per account.')
    next.words = [...next.words.filter(item => item.id !== id), { id, word: terms[0], heardAs: terms[1] }]
  } else {
    if (typeof edit.text !== 'string' || !edit.text.trim() || edit.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(edit.text)) throw new Error('Enter the shortcut text, up to 4,000 characters.')
    if (!edit.id && next.snippets.length >= 50) throw new Error('You can save up to 50 shortcuts per account.')
    next.snippets = [...next.snippets.filter(item => item.id !== id), { id, phrase: terms[0], text: edit.text }]
  }
  return next
}

/** Serialized, encrypted writes. A failed save never replaces the last usable in-memory copy. */
export class DictationVocabularyStore {
  private cache = new Map<string, Promise<DictationVocabulary>>()
  private writes = new Map<string, Promise<unknown>>()
  private file(accountId: string): string {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw new Error('Choose a subscription account first.')
    return `dictation-vocabulary/${createHash('sha256').update(accountId).digest('hex')}.bin`
  }
  async get(accountId: string): Promise<DictationVocabulary> {
    const file = this.file(accountId)
    await this.writes.get(accountId)
    if (!this.cache.has(accountId)) this.cache.set(accountId, readSecret<DictationVocabulary>(file).then(saved => {
      if (!saved) return empty()
      if (!Array.isArray(saved.words) || !Array.isArray(saved.snippets)) throw new Error('Your saved vocabulary could not be read.')
      // Validate disk data using the same rules as edits, preserving stable IDs.
      let checked = empty()
      const ids = new Set<string>()
      for (const item of [...saved.words.map(word => ({ ...word, kind: 'word' as const })), ...saved.snippets.map(snippet => ({ ...snippet, kind: 'snippet' as const }))]) {
        if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Your saved vocabulary could not be read.')
        ids.add(item.id)
        checked = editVocabulary(checked, { ...item, id: undefined })
        const list = item.kind === 'word' ? checked.words : checked.snippets
        list[list.length - 1].id = item.id
      }
      return checked
    }))
    const pending = this.cache.get(accountId)!
    try { return structuredClone(await pending) }
    catch (error) { if (this.cache.get(accountId) === pending) this.cache.delete(accountId); throw error }
  }
  async edit(accountId: string, edit: DictationVocabularyEdit): Promise<DictationVocabulary> {
    const file = this.file(accountId)
    // Capture the current read before putting this write in the queue (get waits for previous writes).
    const before = this.get(accountId)
    const write = before.then(async previous => {
      const next = editVocabulary(previous, edit)
      await writeSecret(file, next)
      this.cache.set(accountId, Promise.resolve(next))
      return structuredClone(next)
    })
    this.writes.set(accountId, write.catch(() => undefined))
    return write
  }
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
const boundary = '[\\p{L}\\p{N}\\p{M}_]'

/** Exact, longest-first replacements only. Snippet contents never go to the cleanup model. */
export function prepareDictationText(raw: string, vocabulary: DictationVocabulary) {
  const nonce = randomUUID().replaceAll('-', '')
  const prefix = `TOGLE_SNIPPET_${nonce}_`
  const snippets: { token: string; text: string }[] = []
  const rules = [
    ...vocabulary.snippets.map(item => ({ phrase: item.phrase, text: item.text, snippet: true })),
    ...vocabulary.words.flatMap(item => [...new Set([item.word, item.heardAs].filter(Boolean))].map(phrase => ({ phrase, text: item.word, snippet: false })))
  ].sort((a, b) => b.phrase.length - a.phrase.length)
  const lookup = new Map(rules.map(rule => [key(rule.phrase), rule]))
  const alone = vocabulary.snippets.find(item => key(raw.replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/gu, '')) === key(item.phrase))
  const pattern = rules.length ? new RegExp(`(?<!${boundary})(?:${rules.map(rule => escaped(rule.phrase)).join('|')})(?!${boundary})`, 'giu') : undefined
  const replace = (match: string): string => {
    const rule = lookup.get(key(match))!
    if (!rule.snippet) return rule.text
    const token = `${prefix}${snippets.length}_END`
    snippets.push({ token, text: rule.text })
    return token
  }
  const text = alone ? replace(alone.phrase) : pattern ? raw.normalize('NFC').replace(pattern, replace) : raw
  const restore = (candidate: string): string => {
    // A model that drops, duplicates or invents a placeholder cannot change a saved shortcut.
    const valid = snippets.every(item => candidate.split(item.token).length === 2) && (candidate.match(new RegExp(prefix, 'g'))?.length ?? 0) === snippets.length
    let result = valid ? candidate : text
    for (const item of snippets) result = result.replace(item.token, () => item.text)
    return result
  }
  return { text, restore, onlySnippet: !!alone }
}
