// What was said in a session or a chat with an AI (Claude Code, Codex, claude.ai, ChatGPT), written down as a document:
// day by day, what they said and the AI replied, a line for each thing it did, without keys and passwords.

// Of what a tool from their workspace (a Jira, a GitHub) gave the agent: the ticket or the issue it looked up.
export const TOOL_RESULT_CHARS = 1_500
// One line of what was done: a command, a file, a search.
const ACTION_CHARS = 140
// Of what it did between two things it said, the files it edited and the other things it did, each this many at most.
const ACTIONS_SHOWN = 6
export const EDITED = 'edited '

// ---- Keys, passwords and tokens ----

const REMOVED = '[secret removed]'

/**
 * Whether what's written after "password:" or "TOKEN=" looks made up to be secret (a password, a key), not a word, a
 * number, a path, or code that reads it from somewhere ("req.headers.authorization", "process.env.API_KEY").
 */
function secretLike(value: string): boolean {
  if (value.startsWith('[secret')) return false
  if (/^(?:process\.env|os\.environ|env\b|config\b|settings\b|secrets?\.|self\.|this\.|req\.|request\.|getenv|ENV\[|\$|%\w+%|<|\{)/i.test(value)) return false
  // A name in code (a.b.c), a call, a path.
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+;?$/.test(value) || value.includes('(') || /^(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?[\\/])/.test(value)) return false
  // Letters and digits together (hunter2, a key), or a long run of both cases (a key without digits).
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || (value.length >= 16 && /[a-z]/.test(value) && /[A-Z]/.test(value) && !/['’]/.test(value))
}
const unlessPlain = (keep: string) => (match: string, lead: string, value: string): string => (secretLike(value) ? `${lead}${keep}` : match)

// Each takes time in proportion to the text's length (no pattern can backtrack over it).
const SECRETS: [RegExp, string | ((...m: string[]) => string)][] = [
  // A private key (PGP's too), or one cut off before its end line.
  [
    /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,10000}?-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s]{0,10000})/g,
    REMOVED
  ],
  [/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, REMOVED],
  [/\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, REMOVED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})/g, REMOVED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REMOVED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REMOVED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REMOVED],
  [/\bnpm_[A-Za-z0-9]{36}/g, REMOVED],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/g, REMOVED],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REMOVED],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, REMOVED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REMOVED],
  // Webhooks, whose address is the key.
  [/\b(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]{20,}/g, `$1${REMOVED}`],
  [/\b(https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]{20,}/g, `$1${REMOVED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi, `$1 ${REMOVED}`],
  // An address with its password in it: a database's (postgresql+psycopg2://app:…@, redis://:…@), a registry's.
  [/\b([a-z][a-z0-9+.-]{1,30}:\/\/[^:\s/@]{0,100}:)[^@\s/]{1,200}@/gi, `$1${REMOVED}@`],
  // A connection string's key (Azure's AccountKey=…;), and passwords given to commands.
  [/\b((?:Account|SharedAccess)Key=)[^;\s"']{10,200}/g, `$1${REMOVED}`],
  [/(\bcurl\b[^\n]{0,200}?\s(?:-u|--user)\s+[^:\s]{1,100}:)\S{1,200}/g, `$1${REMOVED}`],
  [/(\bmysql(?:dump|admin)?\b[^\n]{0,200}?\s-p)[^\s-]\S{0,200}/g, `$1${REMOVED}`],
  [/(\bdocker\s+login\b[^\n]{0,200}?\s(?:-p|--password)[\s=]+)\S{1,200}/g, `$1${REMOVED}`],
  // A password in quotes, spaces and all; and one said in words ("the password is …").
  [/(\b(?:password|passwd|passphrase)["']?\s{0,3}[:=]\s{0,3})(["'])[^"'\n]{4,200}\2/gi, `$1$2${REMOVED}$2`],
  [/(\b(?:password|passcode|passphrase)\s+(?:is|was)\s+["']?)([^\s"',;]{4,100})/gi, unlessPlain(REMOVED)],
  // A setting of theirs by its name: DB_PASS=…, SECRET_KEY_BASE=…, SMTP_PASSWORD="…".
  [/(\b[A-Z][A-Z0-9_]*(?:PASS|SECRET|TOKEN|KEY|CREDENTIALS?)[A-Z0-9_]*\s{0,3}=\s{0,3}["']?)([^\s"'`]{4,200})/g, unlessPlain(REMOVED)],
  [
    /((?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd)["']?\s{0,3}[:=]\s{0,3}["']?)([^\s"'`,;)}\]]{6,200})/gi,
    unlessPlain(REMOVED)
  ]
]

/** A text with the keys, tokens and passwords in it taken out: it's kept, and goes to the model with each call. */
export function withoutSecrets(text: string): string {
  let out = text
  for (const [pattern, put] of SECRETS) out = typeof put === 'string' ? out.replace(pattern, put) : out.replace(pattern, put as (...m: string[]) => string)
  return out
}

// ---- Reading their records ----

export type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** A time as it's written (seconds, milliseconds, or a date), in milliseconds; 0 when it isn't one. */
export const timeOf = (v: unknown): number => {
  const at = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(str(v))
  return Number.isFinite(at) ? at : 0
}
export const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export const day = (at: number): string => new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const clock = (at: number): string => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// What the tool wrote at the top of a summary of the session so far, and its instructions to itself after it.
const SUMMARY_NOISE = [
  /^This session is being continued from a previous conversation[^\n]*\n*/i,
  /\n*If you need specific details from before compaction[\s\S]*$/i,
  /\n*Please continue the conversation from where we left it off[\s\S]*$/i,
  /\n*Continue the conversation from where it left off[\s\S]*$/i
]
const summaryText = (text: string): string => SUMMARY_NOISE.reduce((t, noise) => t.replace(noise, ''), text).trim()

export class Transcript {
  private parts: { text: string; summary?: boolean }[] = []
  /** What it did since it last said something: a line each, by the call it was (to amend as the call ends). */
  private actions: { key?: string; text: string }[] = []
  private day = ''
  private lastAt = 0
  firstAt = 0
  said = 0
  replies = 0

  constructor(private ai: string) {}

  private at(at: number): void {
    if (!at) return
    if (!this.firstAt) this.firstAt = at
    this.lastAt = Math.max(this.lastAt, at)
    const today = day(at)
    if (today !== this.day) {
      this.flush()
      this.day = today
      this.parts.push({ text: `# ${today}` })
    }
  }

  /** What it did since it last said something, on one line: the files it edited together, and the first few other things. */
  private flush(): void {
    if (!this.actions.length) return
    const unique = [...new Set(this.actions.map((a) => a.text))]
    const edited = unique.filter((a) => a.startsWith(EDITED)).map((a) => a.slice(EDITED.length))
    const others = unique.filter((a) => !a.startsWith(EDITED))
    const more = (n: number): string => (n > 0 ? ` and ${n} more` : '')
    const line = [
      edited.length ? `${EDITED}${edited.slice(0, ACTIONS_SHOWN).join(', ')}${more(edited.length - ACTIONS_SHOWN)}` : '',
      ...others.slice(0, ACTIONS_SHOWN),
      others.length > ACTIONS_SHOWN ? `${others.length - ACTIONS_SHOWN} more things` : ''
    ].filter(Boolean)
    this.parts.push({ text: `(${line.join(' · ')})` })
    this.actions = []
  }

  me(text: string, at: number, images = 0): void {
    const words = withoutSecrets(text.trim())
    if (!words && !images) return
    this.at(at)
    this.flush()
    this.said++
    const pictures = images ? ` [${images === 1 ? 'a picture' : `${images} pictures`}]` : ''
    this.parts.push({ text: `Me${at ? ` (${clock(at)})` : ''}: ${words}${pictures}` })
  }

  reply(text: string, at: number): void {
    const words = withoutSecrets(text.trim())
    if (!words) return
    this.at(at)
    this.flush()
    this.replies++
    this.parts.push({ text: `${this.ai}: ${words}` })
  }

  /** Something it did; `key` names the call, for `ended` to amend. */
  did(action: string, at: number, key?: string): void {
    const line = oneLine(withoutSecrets(action), ACTION_CHARS)
    if (!line) return
    this.at(at)
    this.actions.push({ key, text: line })
  }

  /**
   * A call it made, ended: its line, if it's still to be written, changed (or dropped, for null). False when there's
   * no such line (the call was never seen, or its line is written already).
   */
  ended(key: string, change: (text: string) => string | null): boolean {
    const i = this.actions.findIndex((a) => a.key === key)
    if (i < 0) return false
    const text = change(this.actions[i].text)
    if (text === null) this.actions.splice(i, 1)
    else this.actions[i] = { key, text: oneLine(text, ACTION_CHARS) }
    return true
  }

  /** Something it got from a tool of their workspace (a ticket, an issue), or an answer they gave it. */
  got(label: string, text: string, at: number, max = TOOL_RESULT_CHARS): void {
    const body = withoutSecrets(text.trim())
    if (!body) return
    this.at(at)
    this.flush()
    this.parts.push({ text: `${label}: ${body.length > max ? `${body.slice(0, max).trimEnd()}…` : body}` })
  }

  /** What the tool wrote of the session so far when it ran out of room: only the latest is kept. */
  summary(text: string, at: number): void {
    const body = summaryText(withoutSecrets(text))
    if (!body) return
    this.at(at)
    this.flush()
    this.parts.push({ text: `### Summary of the work so far, written in the session\n\n${body}`, summary: true })
  }

  text(header: string): string {
    this.flush()
    const latest = this.parts.findLastIndex((p) => p.summary)
    const body = this.parts.filter((p, i) => !p.summary || i === latest).map((p) => p.text)
    return `${header}\n\n${body.join('\n\n')}`
  }

  get endedAt(): number {
    return this.lastAt
  }
}

// How each part of a session's text starts (Transcript.text): a message of mine, one of the agent's, what a tool of
// theirs gave (or what I attached, answered, or it wrote), a question it asked me, what it did; and the header saying
// whose session it is.
const MINE = /^Me(?: \(\d{1,2}:\d{2}\))?: /
const THEIRS = /^(?:Claude|Codex|ChatGPT): /
const GOT = /^(?:What .{1,80} gave|My answer|What I attached(?: \(.*\))?|(?:Claude|ChatGPT) wrote(?: ".*")?): /
const ASKED_ME = /^(?:Claude|Codex|ChatGPT) asked me: /
const DID = /^\(.*\)$/
const HEADER = /^A (?:session with|chat on) .*"Me" is the user;/
// The headings Transcript.text writes between parts (a day, the summary of the work so far): one in a message of mine
// ("# Notes") isn't one of them.
const DAY_HEADING = /^# [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}$/
const SUMMARY_HEADING = '### Summary of the work so far, written in the session'

/**
 * What of a session's text doesn't say how things are, for the facts a call shows the moment a question ends: my
 * messages (what I asked or told it), its questions to me, what it did, and the header. Each line, and each sentence of
 * one, as a search passage may hold it: a long message of mine goes on over several passages, without its "Me:".
 */
export function notFacts(text: string): Set<string> {
  const out = new Set<string>()
  let mine = false
  text.split('\n').forEach((line, i) => {
    if (MINE.test(line) || ASKED_ME.test(line)) mine = true
    else if (i === 0 || THEIRS.test(line) || GOT.test(line) || DAY_HEADING.test(line) || line === SUMMARY_HEADING) mine = false
    const whole = line.trim()
    if (!whole || !(mine || DID.test(line) || HEADER.test(line))) return
    out.add(whole)
    for (const sentence of whole.split(/(?<=[.!?])\s+/)) out.add(sentence.trim())
  })
  return out
}

/** A line of a session's text as a fact: without the name of the agent that said it. */
export const asFact = (line: string): string => line.replace(THEIRS, '')

const LEFT_OUT = '\n\n[… the middle of the session is left out …]\n\n'

/** A session read for studying: what was asked at its start, and as much of its end as fits (where it stands). */
export function sessionForStudy(text: string, max: number): string {
  if (text.length <= max) return text
  const start = Math.round(max * 0.2)
  const cut = text.lastIndexOf('\n\n', start)
  const head = text.slice(0, cut > start / 2 ? cut : start)
  const tail = text.slice(text.length - (max - head.length - LEFT_OUT.length))
  // From the start of a message, when one starts near the cut.
  const from = tail.indexOf('\n\n')
  return `${head}${LEFT_OUT}${from >= 0 && from < 2000 ? tail.slice(from + 2) : tail}`
}
