import { parentPort } from 'node:worker_threads'
import { AccessibleMeetings, type MeetingAccessibility } from './meeting-accessibility'
import { linuxMeetingAccessibility } from './meeting-linux'
import { macMeetingAccessibility } from './meeting-mac'

// The main process receives a call identifier, a service name and microphone state. It never receives window labels or URLs.
const channel = parentPort ?? process.parentPort
if (channel && (process.platform === 'linux' || process.platform === 'darwin')) {
  let ui: MeetingAccessibility | undefined
  try { ui = process.platform === 'darwin' ? macMeetingAccessibility() : linuxMeetingAccessibility() }
  catch { channel.postMessage('.') }
  if (ui) {
    const owner = Number(process.argv[2]) || process.pid
    const reader = new AccessibleMeetings(ui, process.platform, event => channel.postMessage(event), owner)
    let scan: NodeJS.Timeout
    const read = () => {
      reader.read()
      channel.postMessage('.')
      scan = setTimeout(read, reader.tracking ? 350 : 1700)
    }
    const backend = ui
    const pump = setInterval(() => { if (reader.tracking) backend.pump() }, 55)
    channel.once('message', () => {
      clearInterval(pump)
      clearTimeout(scan)
      reader.stop()
      parentPort?.close()
    })
    read()
  }
}
