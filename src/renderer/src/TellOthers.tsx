import { useState } from 'react'
import { tellOthersLine } from '@shared/meeting'
import { FormOver } from './Rows'

// How long Copy says "Copied".
const COPIED_MS = 1500

/**
 * During a call, until the person says they did: the line to tell the others that the call is being written down.
 * The notes record whether it was ticked. The line says what is done with the sound: it stays on this computer.
 */
export function TellOthers({ onTold }: { onTold: () => void }) {
  const line = tellOthersLine()
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

const askBeforeNotes = 'Is everyone okay with Togle transcribing this call? The audio stays on my computer. The transcript may go to my connected AI service to prepare the notes.'

/** The person asks the other participants before Togle opens either audio input. */
export function MeetingConsent({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <FormOver label="Before taking notes" className="meeting-consent" onClose={onClose} onSubmit={onStart}>
      <h2>Before taking notes</h2>
      <p>Ask everyone before Togle starts transcribing. You can say this or paste it into the call chat.</p>
      <p className="hint">{askBeforeNotes}</p>
      <div className="row">
        <button type="button" className="ghost" onClick={() => void navigator.clipboard.writeText(askBeforeNotes).then(() => setCopied(true), () => undefined)}>
          {copied ? 'Copied' : 'Copy message'}
        </button>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary">Everyone agreed · Start notes</button>
      </div>
    </FormOver>
  )
}
