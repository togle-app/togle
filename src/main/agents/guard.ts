// Before an agent someone else made is installed, what it says is checked, as Hermes Agent scans every skill from its
// hub. An agent only steers what Togle suggests, so the danger is in its words: instructions that try to take over the
// model, send what's said on a call somewhere, get the people on a call to hand over passwords or payments, or hide
// text from the person reading it. In its setup, skills, answers and memory those block the install; in a document
// (reference material, which answers draw facts from) they're shown to look at. Links, email addresses and phone
// numbers it may suggest are shown too.
//
// Every rule runs on a short stretch of text with bounded patterns, so checking a document of millions of characters
// takes a moment, not minutes.
import type { GuardFinding } from '@shared/types'

/** What kind of text it is: what the agent is (setup, skills, answers, memory, names), or a document it reads. */
export type GuardKind = 'setup' | 'document'

interface ClauseRule {
  what: string
  test: RegExp
  /** Only ever shown, never blocking. */
  caution?: true
  /** A "never …" or "don't …" before it means the opposite ("Never ask for their password"). */
  negatable?: true
  /** A clause without this can't match: it isn't tried. */
  needs?: RegExp
}

// Each tried on one clause (a sentence or line) of at most CLAUSE characters.
const CLAUSE_RULES: ClauseRule[] = [
  {
    what: 'tries to override the instructions Togle gives the model',
    test: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|other|system|safety|original)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|directions?|guidelines?)\b/i,
    negatable: true
  },
  {
    what: 'asks the model to reveal its hidden instructions',
    test: /\b(?:reveal|print|repeat|output|show|leak)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|your (?:system )?(?:prompt|instructions))\b/i,
    negatable: true
  },
  {
    what: "sends what's said on the call somewhere",
    // Only to somewhere a model could reach: a web address, an email address, a webhook or a server.
    test: /\b(?:send|post|upload|forward|e-?mail|transmit|leak)\b[^.\n]{0,60}\b(?:transcripts?|the call|this call|conversations?|recordings?|call notes|what (?:they|was|is) said|everything said)\b[^.\n]{0,40}\b(?:to|at|via)\b[^.\n]{0,40}(?:https?:\/\/|www\.|[\w.+-]{1,64}@[\w-]{1,63}\.|\bwebhooks?\b|\bendpoints?\b|\bservers?\b)/i,
    negatable: true
  },
  {
    what: 'asks for passwords, codes or payment details',
    // Asking for one, or for it to be said, read out, given or sent: not "ask them to click Forgot password".
    test: /\b(?:ask(?:ing)?(?:\s+\w+){0,3}?\s+(?:for|to\s+(?:give|read|tell|say|share|send|confirm|spell|type)\b)|request|collect|obtain|get\s+(?:their|the|your)|have\s+(?:them|the caller|the customer)\s+(?:give|read|tell|say))\b[^.\n]{0,40}\b(?:passwords?|passcodes?|pin(?: codes?)?|one-time (?:codes?|passwords?)|otps?|2fa codes?|verification codes?|security codes?|cvv|cvc|card numbers?|credit card(?: numbers?| details)?|bank (?:details|logins?|account numbers?)|seed phrases?|recovery phrases?|private keys?|social security numbers?|ssns?)\b/i,
    negatable: true
  },
  {
    what: 'has payment requests that scams use (gift cards, crypto)',
    test: /\b(?:pay|send|buy|transfer|wire)\b[^.\n]{0,40}\b(?:gift ?cards?|bitcoin|crypto(?:currency)?|usdt|wallet address)\b/i,
    negatable: true
  },
  // Togle shows answers as text, so a picture from the web loads nowhere: worth a look, never fatal.
  { what: 'shows a picture from the web in an answer', test: /!\[[^\]\n]{0,100}\]\(\s{0,5}https?:\/\//i, caution: true, needs: /!\[/ },
  { what: 'email addresses it may suggest', test: /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}\b/, caution: true, needs: /@/ },
  { what: 'phone numbers it may suggest', test: /(?:\+|\b00)\d[\d ()-]{7,24}\d\b/, caution: true, needs: /\d/ }
]

const NEGATION = /\b(?:never|don't|do not|doesn't|does not|mustn't|must not|shouldn't|should not|won't|will not|cannot|can't|no one|nobody|not)\b/i
const CLAUSE = 500

/** The text in stretches a clause rule reads: its sentences and lines, a long one in pieces that overlap. */
function* clauses(text: string): Generator<string> {
  for (const part of text.split(/(?<=[.!?;])\s+|\n+/)) {
    if (part.length <= CLAUSE) yield part
    else for (let at = 0; at < part.length; at += CLAUSE - 100) yield part.slice(at, at + CLAUSE)
  }
}

// What a reader can't see. Some of it deceives: text shown in another order than it's read (direction overrides), or
// read by a model and invisible to people (tag characters). The rest (zero-width spaces, which Thai text and many
// editors use) is only worth a look. Joiners and direction marks (Persian, Arabic, Hebrew, emoji) are fine.
const DECEIVING = /[\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u
const INVISIBLE = /[\u200B\u2060-\u2064\uFEFF]/
// A flag emoji (England, Scotland, Wales) is written with tag characters: those are fine.
const FLAG_TAGS = /\u{1F3F4}[\u{E0061}-\u{E007A}]{1,7}\u{E007F}/gu

const URL = /https?:\/\/[^\s)<>"'\]]{1,500}/gi
// A link with a part to fill in from the call: {transcript}, %7B…, ${…}, <what they said>.
const TEMPLATE = /\{|%7B|\$\{|<[a-z_ ]{1,30}>/i

/** The text around a match, on one line. */
function excerpt(text: string, at: number, length: number): string {
  const from = Math.max(0, at - 40)
  const to = Math.min(text.length, at + length + 40)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`
}

/**
 * What a package's texts (each with where it is, and whether it's a document) have that blocks it (danger) or is
 * worth a look first (caution): one finding per kind of thing, per text.
 */
export function scanTexts(texts: { where: string; text: string; kind?: GuardKind }[]): GuardFinding[] {
  const findings: GuardFinding[] = []
  for (const { where, text, kind = 'setup' } of texts) {
    const strict = kind === 'setup'
    // One finding per kind of thing: a dangerous one takes the place of one only worth a look.
    const found = new Map<string, GuardFinding>()
    const add = (danger: boolean, what: string, shown: string): void => {
      const had = found.get(what)
      if (had && (had.level === 'danger' || !danger)) return
      const finding: GuardFinding = { level: danger ? 'danger' : 'caution', where, what, excerpt: shown }
      if (had) findings[findings.indexOf(had)] = finding
      else findings.push(finding)
      found.set(what, finding)
    }
    const visible = text.replace(/^\uFEFF/, '').replace(FLAG_TAGS, '')
    const deceiving = DECEIVING.exec(visible) ?? INVISIBLE.exec(visible)
    if (deceiving) add(strict && DECEIVING.test(deceiving[0]), 'has text hidden from the reader', excerpt(visible, deceiving.index, 1))
    // Markdown doesn't show an HTML comment: in a document that's common, in what the agent is it hides words.
    const comment = text.indexOf('<!--')
    if (comment >= 0) add(strict, 'has text hidden from the reader', excerpt(text, comment, 4))
    for (const url of text.match(URL) ?? []) {
      if (TEMPLATE.test(url)) add(strict, 'builds a link from what is said on the call', url)
      else add(false, 'links it may suggest', url)
    }
    for (const clause of clauses(text)) {
      for (const rule of CLAUSE_RULES) {
        if (found.get(rule.what)?.level === 'danger' || (rule.caution && found.has(rule.what)) || (rule.needs && !rule.needs.test(clause))) continue
        const match = rule.test.exec(clause)
        if (!match || (rule.negatable && NEGATION.test(clause.slice(0, match.index + match[0].length)))) continue
        add(strict && !rule.caution, rule.what, rule.caution ? match[0] : excerpt(clause, match.index, match[0].length))
      }
    }
  }
  return findings
}
