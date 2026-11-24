const clock = '\\d{1,3}:[0-5]\\d(?::[0-5]\\d)?'
const range = clock + '(?:\\s*[-‐‑‒–—−]\\s*' + clock + ')?'

/** A complete transcript reference, including ranges or several pieces of evidence in one pair of brackets. */
export const meetingCitation = new RegExp('\\[\\s*' + range + '(?:\\s*[,;]\\s*' + range + ')*\\s*\\]', 'g')

export function citationTimes(reference: string): { label: string; seconds: number }[] {
  return reference.slice(1, -1).split(/[,;]/).map(part => {
    const label = part.trim().replace(/\s*[-‐‑‒–—−]\s*/, '–')
    const start = label.split('–')[0]
    return { label, seconds: start.split(':').reduce((total, n) => total * 60 + Number(n), 0) }
  })
}
