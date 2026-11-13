import { useState } from 'react'
import type { Settings } from '@shared/types'
import { tellOthersLine } from '@shared/meeting'

// How long Copy says "Copied".
const COPIED_MS = 1500

/**
 * During a call, until the person says they did: the line to tell the others that the call is being written down.
 * The notes record whether it was ticked. The line says where the sound goes, as this computer hears it.
 */
export function TellOthers({ transcription, onTold }: { transcription: Settings['transcription']; onTold: () => void }) {
  const line = tellOthersLine(transcription)
  const [copied, setCopied] = useState(false)
  return (
    <div className="tell-others" role="group" aria-label="Tell the others" title={line}>
      <strong>Tell the others</strong>
      <q className="tell-line">{line}</q>
      <span className="tell-actions">
        <label className="tell-tick"><input type="checkbox" onChange={(event) => { if (event.target.checked) onTold() }} />I told them</label>
        <button
          className="primary small"
          onClick={() => void navigator.clipboard.writeText(line).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), COPIED_MS)
          }, () => undefined)}
        >
          {copied ? 'Copied' : 'Copy the line'}
        </button>
      </span>
    </div>
  )
}

/** Said once, when the first call starts: the rules differ by place, and where the words and the sound go. */
export function FirstCallNotice({ settings, onDone }: { settings: Settings; onDone: () => void }) {
  const here = settings.transcription.me === 'local' && settings.transcription.them === 'local'
  return (
    <div className="notice ask first-call" role="alert" aria-label="Before your first call">
      <span>
        <strong>Before your first call.</strong> The rules for writing down a call differ by place. The words go to your AI plan, which writes the notes{here ? '; the sound stays on this computer.' : ', and the sound to the speech service you chose in Settings.'}
      </span>
      <div className="row">
        <button className="primary" autoFocus onClick={onDone}>Got it</button>
      </div>
    </div>
  )
}
