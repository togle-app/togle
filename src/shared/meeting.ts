import type { TranscriptEntry } from './types'

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
  return line.voiceName ? `${line.voiceName}${line.voiceNamedBy === 'suggested' ? '?' : ''}` : line.speaker === 'me' ? 'You' : line.voiceId ? `Speaker ${line.voiceId.split(':').at(-1)}` : 'Them'
}

export interface CalendarMeeting {
  agentId?: string
  agentName?: string
  id: string
  title: string
  start: number
  end: number
  attendees: number
  url?: string
}

export interface CalendarStatus {
  agentId?: string
  agentName?: string
  state: 'off' | 'checking' | 'ready' | 'needs-connection' | 'error'
  account?: string
  events: CalendarMeeting[]
  checkedAt?: number
  error?: string
}

/** Accept only timed, bounded meetings. All-day/cancelled/declined entries are not call reminders. */
export function calendarMeetings(value: unknown, now: number): CalendarMeeting[] {
  if (!Array.isArray(value)) return []
  const result = new Map<string, CalendarMeeting>()
  for (const event of value.slice(0, 100)) {
    if (!event || typeof event !== 'object' || event.cancelled || event.declined || event.allDay || typeof event.id !== 'string') continue
    const start = typeof event.start === 'number' ? event.start : Date.parse(event.start)
    const end = typeof event.end === 'number' ? event.end : Date.parse(event.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= now || start > now + 24 * 3600_000 || end - start > 24 * 3600_000) continue
    const title = typeof event.title === 'string' ? event.title.replace(/[\r\n]/g, ' ').trim().slice(0, 180) : ''
    if (!title) continue
    const url = typeof event.url === 'string' && /^https:\/\//i.test(event.url) ? event.url.slice(0, 2000) : undefined
    result.set(event.id.slice(0, 200), { id: event.id.slice(0, 200), title, start, end, attendees: Number.isInteger(event.attendees) ? Math.max(0, Math.min(1000, event.attendees)) : 0, url })
  }
  return [...result.values()].sort((a, b) => a.start - b.start)
}

export function dueMeeting(events: CalendarMeeting[], now: number, dismissed: ReadonlySet<string>): CalendarMeeting | undefined {
  return events.find(event => !dismissed.has(event.id) && event.start <= now + 5 * 60_000 && event.end > now)
}

/** A manual start may use one unambiguous meeting from this agent's calendar. */
export function meetingForCall(status: CalendarStatus, agentId: string, now: number, selectedId?: string): CalendarMeeting | undefined {
  if (!selectedId && (status.state !== 'ready' || !Number.isFinite(status.checkedAt) || now - status.checkedAt! > 30 * 60000 || status.checkedAt! > now)) return
  const current = status.events.filter(event => event.agentId === agentId && event.start <= now + 5 * 60_000 && event.end > now)
  if (selectedId) return current.find(event => event.id === selectedId)
  return current.length === 1 ? current[0] : undefined
}
