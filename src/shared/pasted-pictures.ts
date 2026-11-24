/** Togle's clipboard and Show filenames can be recognized in existing agent conversations. */
export const MAX_SHOW_PNG_BYTES = 60 * 1024 * 1024
const pastedLocation = /[\\/]pasted[\\/]paste-[\w-]+\.(?:png|jpe?g|gif|webp)/.source
const showLocation = /[\\/]pictures[\\/]show-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.png/.source
const location = '(?:' + pastedLocation + '|' + showLocation + ')'
const pictureEnd = new RegExp(location + '$', 'i')
const showEnd = new RegExp(showLocation + '$', 'i')
const shellQuotedBody = /(?:[^'\r\n]|'\\'')*/.source
const PATH = new RegExp('(?:' + [
  '"([^"\\r\\n]*' + location + ')"',
  "'(" + shellQuotedBody + location + ")'",
  '([^\\s"<>|]*' + location + ')(?![\\w/\\\\-]|\\.\\w)'
].join('|') + ')[ \\t]*', 'gi')

export const isChatPicture = (path: string): boolean => pictureEnd.test(path)
export const isShowPicture = (path: string): boolean => showEnd.test(path)
export function attachmentCount(paths: string[]): string {
  const noun = paths.every(file => /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i.test(file)) ? 'picture' : 'file'
  return paths.length === 1 ? `a ${noun}` : `${paths.length} ${noun}s`
}
const attachmentHeading = 'Attached files'
const blockHeading = new RegExp('(?:^|\\r?\\n\\r?\\n)' + attachmentHeading + '(?=(\\r?\\n))', 'g')
const inlineHeading = attachmentHeading + ': '
const localPath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path) && !/[\u0000-\u001f\u007f]/.test(path)

/** Show publishes a PNG and its quoted path together, so ordinary text fields can accept the same paste. */
export function showClipboardPath(text: string): string | undefined {
  const trimmed = text.trim()
  const file = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
  return localPath(file) && !file.includes('"') && isShowPicture(file) ? file : undefined
}

/** A retained F8 capture adds its dictated words after the quoted PNG path in the plain-text format. */
export function showClipboardContent(text: string): { file: string; words: string } | undefined {
  const quoted = /^"([^"\r\n]+)" ([\s\S]*)$/.exec(text)
  const file = showClipboardPath(quoted ? quoted[1] : text)
  return file ? { file, words: quoted?.[2] ?? '' } : undefined
}

/** A trailing block keeps opaque local paths, including spaces and quotes, separate from the person's words. */
export function withFilePaths(words: string, paths: string[]): string {
  return paths.length ? [words.trim(), attachmentHeading + '\n' + paths.join('\n')].filter(Boolean).join('\n\n') : words
}

function fileBlock(text: string): { words: string; files: string[] } | undefined {
  const heading = Array.from(text.matchAll(blockHeading)).at(-1)
  if (!heading) return
  const start = heading.index + heading[0].length + heading[1].length
  const files = text.slice(start).replace(/(?:\r?\n)+$/, '').split(/\r?\n/)
  if (files.every(localPath)) return { words: text.slice(0, heading.index), files }
}

/** A terminal submits one line. A JSON list keeps the boundaries of paths with spaces or quotes. */
export function filePathsForTerminal(text: string): string {
  const block = fileBlock(text)
  return block ? [block.words, inlineHeading + JSON.stringify(block.files)].filter(Boolean).join(' ') : text
}

function inlineFileList(text: string): { words: string; files: string[] } | undefined {
  const at = text.lastIndexOf(inlineHeading + '["')
  if (at < 0 || (at > 0 && text[at - 1] !== ' ')) return
  try {
    const files: unknown = JSON.parse(text.slice(at + inlineHeading.length))
    if (Array.isArray(files) && files.length && files.every(file => typeof file === 'string' && localPath(file))) {
      return { words: at ? text.slice(0, at - 1) : '', files }
    }
  } catch { /* An ordinary sentence can contain the same heading. */ }
}

/** Split the user's words from attached paths, including the older inline format. */
export function splitPictures(text: string): { words: string; files: string[] } {
  const block = fileBlock(text) ?? inlineFileList(text)
  const files = block?.files ?? []
  text = block?.words ?? text
  const attached = files.length
  const rest = text.replace(PATH, (match, quoted: string | undefined, shell: string | undefined, bare: string | undefined, offset: number) => {
    const file = quoted ?? shell?.replaceAll("'\\''", "'") ?? bare
    if (!file || !localPath(file)) return match
    files.push(file)
    // Remove the attachment's own gap without changing spaces or indentation elsewhere in the message.
    const before = text[offset - 1], after = text[offset + match.length]
    return before && after && /\S/.test(before) && /\S/.test(after) ? ' ' : ''
  })
  if (files.length === attached) return { words: text, files }
  const words = rest.trimEnd()
  return { words: /^Pictures?:$/.test(words) ? '' : words, files }
}
