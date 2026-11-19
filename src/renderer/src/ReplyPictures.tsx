import { useCallback, useState } from 'react'
import { Icon } from './Icon'
import { useKeptState } from './kept'
import { PictureOver } from './Rows'

const api = window.togle

/** The kinds of picture a paste can hold that go into a message as a file (a screenshot is a PNG; a bitmap is kept as one). */
const PICTURE = /^image\/(png|jpeg|gif|webp|bmp)$/

/** A picture put in the reply box: kept as a file in Togle's own folder (its path goes with the words), with a copy to show. */
export interface Attached {
  path: string
  name: string
  src: string
}
const NO_PICTURES: Attached[] = []

/** A path as it goes into a message: in quotes when it has a space, as a terminal puts a file dropped on it. */
export const pathWords = (file: string): string => (/\s/.test(file) ? `"${file}"` : file)
const baseName = (file: string): string => file.split(/[\\/]/).pop() || file
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const dataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'))
    reader.readAsDataURL(file)
  })

/** The pictures a paste holds when it holds no words (a screenshot): a paste with words is words, as it is in a terminal. */
export function pastedPictures(data: DataTransfer | null): File[] {
  if (!data || data.getData('text/plain')) return []
  return Array.from(data.items)
    .filter((item) => item.kind === 'file' && PICTURE.test(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file)
}

/**
 * The pictures of a task's reply box, kept with the task while the window is open (as the words typed are). A picture is kept as a
 * file as soon as it is pasted, the same file a paste into the agent's screen makes, and its path goes into the message when it is
 * sent: Claude Code and Codex take a path to a picture as a picture to attach, and any other agent can open the file. `attach` tells
 * what went wrong, in words, when a picture could not be kept (null when all of them were).
 */
export function useAttached(taskKey: string): { pictures: Attached[]; attach: (files: File[]) => Promise<string | null>; again: (file: string) => Promise<void>; remove: (path: string) => void; clear: () => void } {
  const [pictures, setPictures] = useKeptState<Attached[]>(`reply-pictures:${taskKey}`, NO_PICTURES)
  const attach = useCallback(
    async (files: File[]): Promise<string | null> => {
      let problem: string | null = null
      for (const file of files) {
        try {
          const [saved, src] = await Promise.all([file.arrayBuffer().then((bytes) => api.savePastedPicture(new Uint8Array(bytes), file.type)), dataUrl(file)])
          setPictures((now) => (now.some((picture) => picture.path === saved) ? now : [...now, { path: saved, name: baseName(saved), src }]))
        } catch (error) {
          problem = errorText(error)
        }
      }
      return problem
    },
    [setPictures]
  )
  // A picture that was sent and is taken back with its words (a queued message put back in the box): it is read from where it is kept.
  const again = useCallback(
    async (file: string): Promise<void> => {
      const src = await api.pastedPicture(file).catch(() => null)
      if (src) setPictures((now) => (now.some((picture) => picture.path === file) ? now : [...now, { path: file, name: baseName(file), src }]))
    },
    [setPictures]
  )
  const remove = useCallback((path: string) => setPictures((now) => now.filter((picture) => picture.path !== path)), [setPictures])
  const clear = useCallback(() => setPictures(NO_PICTURES), [setPictures])
  return { pictures, attach, again, remove, clear }
}

/**
 * The pictures about to go with a message, over its words: each a small chip with the picture, its name and where it is kept, and a
 * small button at the chip's top right that takes it out. Pressing the chip opens the picture whole over the window.
 */
export function PictureChips({ pictures, onRemove }: { pictures: Attached[]; onRemove: (path: string) => void }) {
  const [open, setOpen] = useState<Attached | null>(null)
  if (!pictures.length) return null
  return (
    <>
      <ul className="reply-chips" aria-label="Pictures that go with the message">
        {pictures.map((picture) => (
          <li key={picture.path} className="reply-chip">
            <button
              type="button"
              className="chip-open"
              title="Open the picture"
              aria-label={`${picture.name}: open it`}
              onClick={(event) => {
                // The keys come back here when it closes.
                event.currentTarget.focus()
                setOpen(picture)
              }}
            >
              <img src={picture.src} alt="" />
              <span className="chip-words">
                <b>{picture.name}</b>
                <small>{picture.path}</small>
              </span>
            </button>
            <button type="button" className="chip-remove" aria-label={`Remove ${picture.name}`} title="Remove" onClick={() => onRemove(picture.path)}>
              <Icon name="close" size={10} />
            </button>
          </li>
        ))}
      </ul>
      {open && <PictureOver src={open.src} label={open.name} onClose={() => setOpen(null)} />}
    </>
  )
}
