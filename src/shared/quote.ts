// Quote and reply, as a chat app has it: part of a message quoted above what the person answers. What goes to the agent is one
// line that starts with a word, since a screen takes a line break as Enter and refuses a line that starts with "/" or "!"
// (runners/terminal.ts). The record the agent keeps of it reads back as a quote and a reply, so Chat can draw it as one.

/** The most of a quoted part that is sent. A longer part is cut, and the cut shows. */
export const QUOTE_MOST = 500

const LEAD = 'Replying to '

/**
 * A quoted part as it is sent: escape sequences, control characters and marks that change a line's direction gone, line
 * breaks and runs of spaces made one space, the curly quotation marks inside it straightened (they would end it early), and
 * a long one cut.
 */
export function cleanQuote(selected: string): string {
  const clean = selected
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > QUOTE_MOST ? `${clean.slice(0, QUOTE_MOST - 1).trimEnd()}…` : clean
}

/** What is sent: the quote, then what the person answers. One line when the answer is one line. */
export function withQuote(quote: string, reply: string): string {
  return `${LEAD}“${cleanQuote(quote)}”: ${reply.trim()}`
}

/** A message read back as a quote and a reply, or null when it is not one. */
export function splitQuote(text: string): { quote: string; reply: string } | null {
  const found = /^Replying to “([^”]+)”:? ?([\s\S]*)$/.exec(text.trim())
  const reply = found?.[2].trim()
  return found && reply ? { quote: found[1], reply } : null
}
