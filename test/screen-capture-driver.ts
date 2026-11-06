// Real production recorder and preload, without microphone access or mocked display capture.
import { ScreenRecorder } from '../src/renderer/src/video/recorder'

const recorder = new ScreenRecorder()
let ended = false
recorder.onEnded = () => { ended = true }
window.togle.onScreenRefresh(id => recorder.captureNow(id))
window.togle.onScreenMonitor(status => {
  if ((status.state === 'off' || status.state === 'paused') && recorder.active) recorder.stop()
})
Object.assign(window, { captureCheck: {
  start: (source: string) => recorder.start(source, true),
  stop: () => recorder.stop(),
  active: () => recorder.active,
  ended: () => ended
} })
