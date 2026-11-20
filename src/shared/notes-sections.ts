// A call's notes as the notes view shows them: the lead before the first "##" heading, and a card for each section after it, with
// what kind of section it is (what was marked, decided, to do, still open, or a topic). The "#" title is left out: the page has the
// call's name, which the notes' title became. The notes text itself is never changed (sharing and exporting use it as it is).

export type NotesKind = 'marked' | 'decided' | 'todo' | 'open' | 'topic'

export interface NotesSection {
  heading: string
  kind: NotesKind
  /** Markdown, with the reference links of the whole notes added so that a link made in another section still works. */
  body: string
  /** A table, a code block or a long text: the section has a row of its own. */
  wide: boolean
}

export interface NotesParts {
  lead: string
  sections: NotesSection[]
}

/** What kind of section a heading names: the words Togle's notes use (Marked, Decided, To do, Action items, Open questions), in any case. */
export function notesKind(heading: string): NotesKind {
  const words = heading.toLowerCase()
  if (/\b(marked|highlights?|moments?)\b/.test(words)) return 'marked'
  if (/\b(decided|decisions?)\b/.test(words) && !/\b(outstanding|open|pending)\b/.test(words)) return 'decided'
  if (/\b(to[- ]?do|action|actions|tasks?|next steps?)\b/.test(words)) return 'todo'
  if (/\b(questions?|outstanding|open|unresolved|pending)\b/.test(words)) return 'open'
  return 'topic'
}

const FENCE = /^\s{0,3}(```|~~~)/
const TITLE = /^#\s+\S/
const SECTION = /^##\s+(.+?)\s*#*\s*$/
const REFERENCE = /^\s{0,3}\[[^\]]+\]:\s+\S/
const TABLE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
// "Name: the task" at the start of an item: the name of the person who took it, said first.
const OWNER = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(?:\*\*)?(You|\p{Lu}[\p{L}'’.-]*(?: \p{Lu}[\p{L}'’.-]*){0,2})(?:\*\*)?:(?:\*\*)?\s+(?=\S)/u

/** Some saved notes spelled out a tentative microphone label inside the task owner. The owner is still explicitly You. */
export function compactNoteOwner(text: string): string {
  return text.replace(/^((?:\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?\**You\**)\s*\(speaker\s+label(?:l)?ed\s+[^()\n]{1,100}?,\s*(?:identity|name)\s+tentative\)(?=\**\s*:)/i, '$1')
}

/** Under To do, the name of who took each item is bold (and drawn as a chip, so its colon is left out), so that the items read by person. */
function ownersFirst(body: string): string {
  return body
    .split('\n')
    .map(line => compactNoteOwner(line).replace(OWNER, '$1**$2** '))
    .join('\n')
}

export function splitNotes(markdown: string): NotesParts {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const references: string[] = []
  const chunks: { heading?: string; lines: string[] }[] = [{ lines: [] }]
  let fenced = false
  let titled = false
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced
    if (!fenced && !FENCE.test(line)) {
      if (REFERENCE.test(line)) references.push(line.trim())
      // The first line that says anything, when it is a "#" heading, is the title.
      if (!titled && line.trim()) {
        titled = true
        if (TITLE.test(line)) continue
      }
      const section = SECTION.exec(line)
      if (section) {
        chunks.push({ heading: section[1], lines: [] })
        continue
      }
    }
    chunks[chunks.length - 1].lines.push(line)
  }
  const tail = references.length ? `\n\n${references.join('\n')}` : ''
  const lead = chunks[0].lines.join('\n').trim()
  const sections: NotesSection[] = []
  for (const chunk of chunks.slice(1)) {
    const text = chunk.lines.join('\n').trim()
    if (!text || chunk.heading === undefined) continue
    const kind = notesKind(chunk.heading)
    const body = kind === 'todo' ? ownersFirst(text) : text
    sections.push({
      heading: chunk.heading,
      kind,
      body: body + tail,
      wide: chunk.lines.some((line) => TABLE.test(line) || FENCE.test(line)) || text.length > 700
    })
  }
  return { lead: lead ? lead + tail : '', sections }
}
