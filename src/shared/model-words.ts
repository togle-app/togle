// A model and an effort in the words a task's status line has for them: "Opus 5.5 · max", "GPT 6.2 Sol · ultra". The agents write them as
// ids ("claude-opus-5-5", "gpt-6.2-sol"); what no rule here knows is shown as the agent wrote it.
import type { ModelInfo } from './runner'

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']
const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

/**
 * A model id as a person says it. Claude's: the family and the version ("claude-opus-5-5" is "Opus 5.5", "claude-3-5-sonnet-20241022" is
 * "Sonnet 3.5", a date or "latest" after it is left out, and a context window Claude Code adds in brackets stays: "Opus 5.5 (1M)"). GPT's:
 * "gpt-6.2-sol" is "GPT 6.2 Sol". Any other id is shown as it is.
 */
export function modelWords(id: string): string {
  const raw = id.trim()
  if (!raw) return ''
  const window = /\[(\d+[km])\]\s*$/i.exec(raw)?.[1]
  const base = raw.replace(/\[[^\]]*\]\s*$/, '').trim()
  const claude = /^claude[-_](.+)$/i.exec(base)
  if (claude) {
    const parts = claude[1].replace(/-\d{8}$/, '').replace(/-latest$/i, '').split('-').filter(Boolean)
    const family = parts.find((part) => FAMILIES.includes(part.toLowerCase()))
    if (family) {
      const version = parts.filter((part) => /^\d+$/.test(part)).join('.')
      return `${capital(family.toLowerCase())}${version ? ` ${version}` : ''}${window ? ` (${window.toUpperCase()})` : ''}`
    }
  }
  const gpt = /^gpt[-_ ]?(.*)$/i.exec(base)
  if (gpt) return ['GPT', ...gpt[1].split(/[-_ ]+/).filter(Boolean).map(capital)].join(' ') + (window ? ` (${window.toUpperCase()})` : '')
  return raw
}

/** What the status line says of a task's model and effort ("Opus 5.5 · max"), or nothing when its agent tells neither. */
export function modelLine(info: ModelInfo | null | undefined): string {
  if (!info) return ''
  return [info.model ? modelWords(info.model) : '', info.effort ? info.effort.trim().toLowerCase() : ''].filter(Boolean).join(' · ')
}

/** The same in full, for the pointer: "Model: Opus 5.5 (claude-opus-5-5). Effort: max." */
export function modelTitle(info: ModelInfo | null | undefined): string {
  if (!info) return ''
  const model = info.model ? `Model: ${modelWords(info.model)}${modelWords(info.model) !== info.model ? ` (${info.model})` : ''}.` : ''
  const effort = info.effort ? `Effort: ${info.effort.trim().toLowerCase()}.` : ''
  return [model, effort].filter(Boolean).join(' ')
}
