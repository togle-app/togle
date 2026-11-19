/**
 * A picture pasted into a reply goes to the agent as the path of the file Togle kept it in (`paste-<time>.<kind>`, in the `pasted`
 * folder of Togle's data). Chat finds such paths in what was said, to draw the pictures where their paths would be. A path with a space
 * in it is in quotes, as a terminal puts a file dropped on it.
 */
const PATH = /"([^"\r\n]*[\\/]pasted[\\/]paste-[\w-]+\.(?:png|jpe?g|gif|webp))"|((?:[A-Za-z]:)?[^\s"'<>|]*[\\/]pasted[\\/]paste-[\w-]+\.(?:png|jpe?g|gif|webp))/gi

/**
 * What was said without the paths of its pasted pictures, and those paths. The word Togle puts before pictures that were sent alone
 * ("Picture:", "Pictures:") is not words of the person's, and goes with them.
 */
export function splitPictures(text: string): { words: string; files: string[] } {
  const files: string[] = []
  const rest = text.replace(PATH, (_all, quoted: string | undefined, bare: string | undefined) => {
    files.push(quoted ?? bare ?? '')
    return ' '
  })
  if (!files.length) return { words: text, files }
  const words = rest.replace(/ {2,}/g, ' ').replace(/ ?\n ?/g, '\n').trim()
  return { words: /^Pictures?:$/.test(words) ? '' : words, files }
}
