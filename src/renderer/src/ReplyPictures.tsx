import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { isChatPicture, showClipboardContent, withFilePaths } from '@shared/pasted-pictures'
import { Icon } from './Icon'
import { useKeptState } from './kept'
import { PictureOver } from './Rows'

const api = window.togle

/** The kinds of picture a paste can hold that go into a message as a file (a screenshot is a PNG; a bitmap is kept as one). */
const PICTURE = /^image\/(png|jpeg|gif|webp|bmp)$/

/** A selected local file or a saved clipboard image, with an optional preview. */
export interface Attached {
  path: string
  name: string
  src?: string
}
const NO_PICTURES: Attached[] = []

export function attachmentMessage(words: string, files: Attached[]): string {
  if (!files.length) return words
  if (files.every(file => isChatPicture(file.path))) {
    const paths = files.map(file => pathWords(file.path)).join(' ')
    return words ? `${words} ${paths}` : `${files.length === 1 ? 'Picture' : 'Pictures'}: ${paths}`
  }
  return withFilePaths(words, files.map(file => file.path))
}

export function diskPath(file: File): string {
  const path = api.attachmentPath?.(file) ?? ''
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('Rename the file to remove control characters before attaching it.')
  return path
}

export function fileDrop(onFiles: (files: File[]) => void) {
  return {
    onDragOver(event: DragEvent) {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDrop(event: DragEvent) {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      onFiles(Array.from(event.dataTransfer.files))
    }
  }
}

export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button className="ghost small icon-only attach-files" type="button" aria-label="Attach files" title="Attach files" onClick={() => input.current?.click()}>
      <Icon name="paperclip" size={18} />
    </button>
    <input ref={input} type="file" multiple hidden aria-label="Choose files to attach" onChange={event => {
      onFiles(Array.from(event.currentTarget.files ?? []))
      event.currentTarget.value = ''
    }} />
  </>
}

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

/** Keep each session's selected files with its draft. Clipboard images need a local copy before the agent can open them. */
export function useAttached(taskKey: string) {
  const [pictures, setPictures] = useKeptState<Attached[]>(`reply-pictures:${taskKey}`, NO_PICTURES)
  const attach = useCallback(
    async (files: File[]): Promise<string | null> => {
      let problem: string | null = null
      for (const file of files) {
        try {
          const path = diskPath(file)
          if (path) {
            setPictures(now => now.some(item => item.path === path) ? now : [...now, { path, name: file.name || baseName(path) }])
            if (PICTURE.test(file.type) && file.size <= 5 * 1024 * 1024) {
              // Stage the whole selection immediately. A late preview must not restore a removed or sent file.
              void dataUrl(file).then(src => setPictures(now => now.some(item => item.path === path)
                ? now.map(item => item.path === path ? { ...item, src } : item)
                : now)).catch(() => undefined)
            }
            continue
          }
          if (!PICTURE.test(file.type)) throw new Error('Choose this file from a folder on your computer.')
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
  // Queue the existing file synchronously. Sending or removing it before the preview loads must leave it removed.
  const again = useCallback(
    async (file: string): Promise<void> => {
      setPictures(now => now.some(item => item.path === file) ? now : [...now, { path: file, name: baseName(file) }])
      const src = isChatPicture(file) ? await api.pastedPicture(file).catch(() => null) : null
      if (src) setPictures(now => now.some(item => item.path === file) ? now.map(item => item.path === file ? { ...item, src } : item) : now)
    },
    [setPictures]
  )
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>, setText: (value: string) => void): Promise<string | null> | undefined => {
    const data = event.clipboardData
    const text = data.getData('text/plain')
    const screenshot = showClipboardContent(text)
    if (screenshot) {
      event.preventDefault()
      if (screenshot.words) {
        const field = event.currentTarget
        field.setRangeText(screenshot.words, field.selectionStart, field.selectionEnd, 'end')
        setText(field.value)
      }
      return again(screenshot.file).then(() => null)
    }
    if (text) return
    const files = Array.from(data.items).filter(item => item.kind === 'file' && PICTURE.test(item.type))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null)
    if (!files.length) return
    event.preventDefault()
    return attach(files)
  }
  const remove = useCallback((path: string) => setPictures((now) => now.filter((picture) => picture.path !== path)), [setPictures])
  const clear = useCallback(() => setPictures(NO_PICTURES), [setPictures])
  return { pictures, attach, again, paste, remove, clear }
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
      <ul className="reply-chips" aria-label="Attached files">
        {pictures.map((picture) => (
          <li key={picture.path} className="reply-chip">
            {picture.src ? <button
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
            </button> : <span className="chip-open" title={picture.path}>
              <Icon name="file" size={16} /><span className="chip-words"><b>{picture.name}</b><small>{picture.path}</small></span>
            </span>}
            <button type="button" className="chip-remove" aria-label={`Remove ${picture.name}`} title="Remove" onClick={() => onRemove(picture.path)}>
              <Icon name="close" size={10} />
            </button>
          </li>
        ))}
      </ul>
      {open?.src && <PictureOver src={open.src} label={open.name} onClose={() => setOpen(null)} />}
    </>
  )
}
