// Which apps record from a microphone on a Mac, for the call notice. macOS 14.2 and later list the processes that use
// sound as Core Audio objects, each with its process id, its bundle id and whether it is recording now. Nothing is asked
// of the person for this. Togle needs macOS 14.2 anyway, for the computer's sound. Not tried on a Mac yet: if Core Audio
// does not answer, no call is noticed, and Write down now still starts one.
import koffi from 'koffi'
import type { MicrophoneUse } from './call-detect'

/** A Core Audio four-character code as the number it stands for ('prs#' → 0x70727323). */
export const fourCharCode = (text: string): number =>
  [...text].reduce((code, char) => ((code << 8) | char.charCodeAt(0)) >>> 0, 0)

const SYSTEM_OBJECT = 1
const GLOBAL = fourCharCode('glob')
const MAIN_ELEMENT = 0
const PROCESS_LIST = fourCharCode('prs#')
const PROCESS_PID = fourCharCode('ppid')
const PROCESS_BUNDLE = fourCharCode('pbid')
const PROCESS_RECORDING = fourCharCode('piri')
const UTF8 = 0x08000100

type Reader = () => { pid: number; bundle?: string; recording: boolean }[]
let reader: Reader | null | undefined

function load(): Reader | null {
  if (reader !== undefined) return reader
  try {
    const audio = koffi.load('/System/Library/Frameworks/CoreAudio.framework/CoreAudio')
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    koffi.struct('AudioObjectPropertyAddress', { selector: 'uint32_t', scope: 'uint32_t', element: 'uint32_t' })
    const sizeOf = audio.func('int32_t AudioObjectGetPropertyDataSize(uint32_t object, const AudioObjectPropertyAddress *address, uint32_t qualifierSize, const void *qualifier, _Out_ uint32_t *size)')
    const read = audio.func('int32_t AudioObjectGetPropertyData(uint32_t object, const AudioObjectPropertyAddress *address, uint32_t qualifierSize, const void *qualifier, _Inout_ uint32_t *size, void *data)')
    const text = cf.func('bool CFStringGetCString(void *string, void *buffer, intptr_t size, uint32_t encoding)')
    const release = cf.func('void CFRelease(void *object)')
    const address = (selector: number) => ({ selector, scope: GLOBAL, element: MAIN_ELEMENT })
    const value = (object: number, selector: number, bytes: number): Buffer | undefined => {
      const data = Buffer.alloc(bytes)
      const size = [bytes]
      return read(object, address(selector), 0, null, size, data) === 0 ? data : undefined
    }
    reader = () => {
      const size = [0]
      if (sizeOf(SYSTEM_OBJECT, address(PROCESS_LIST), 0, null, size) !== 0 || !size[0]) return []
      const list = value(SYSTEM_OBJECT, PROCESS_LIST, size[0])
      if (!list) return []
      const found: { pid: number; bundle?: string; recording: boolean }[] = []
      for (let at = 0; at + 4 <= list.length; at += 4) {
        const process = list.readUInt32LE(at)
        const recording = value(process, PROCESS_RECORDING, 4)?.readUInt32LE(0)
        if (!recording) continue
        const pid = value(process, PROCESS_PID, 4)?.readInt32LE(0) ?? 0
        let bundle: string | undefined
        const reference = value(process, PROCESS_BUNDLE, 8)?.readBigUInt64LE(0)
        if (reference) {
          // The bundle id comes as a string Core Audio made for this call; it is released once read.
          const out = Buffer.alloc(512)
          try { if (text(reference, out, out.length, UTF8)) bundle = out.toString('utf8', 0, out.indexOf(0)) || undefined }
          finally { release(reference) }
        }
        found.push({ pid, bundle, recording: true })
      }
      return found
    }
  } catch (error) {
    console.warn('[calls] Core Audio did not load:', (error as Error).message)
    reader = null
  }
  return reader
}

/** The apps recording from a microphone now, by bundle id, as seen now (Core Audio does not say since when). */
export function readMacMicrophoneUse(now = Date.now()): MicrophoneUse[] {
  const read = load()
  if (!read) return []
  try {
    return read().filter((entry) => entry.pid !== process.pid && entry.bundle).map((entry) => ({ name: entry.bundle!, since: now }))
  } catch (error) {
    console.warn('[calls] Core Audio could not be read:', (error as Error).message)
    return []
  }
}
