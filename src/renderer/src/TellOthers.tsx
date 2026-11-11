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
      <span className="tell-actions">
        <button
          className="ghost small"
          onClick={() => void navigator.clipboard.writeText(line).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), COPIED_MS)
          }, () => undefined)}
        >
          {copied ? 'Copied' : 'Copy the line'}
        </button>
        <button className="primary small" onClick={onTold}>I told them</button>
      </span>
      <p className="tell-line">{line}</p>
    </div>
  )
}

const AI_NAME: Record<string, string> = { chatgpt: 'your ChatGPT plan', claude: 'your Claude account' }

/** Said once, when the first call starts: the rules differ by place, and where the words and the sound go. */
export function FirstCallNotice({ settings, onDone }: { settings: Settings; onDone: () => void }) {
  const here = settings.transcription.me === 'local' && settings.transcription.them === 'local'
  const ai = AI_NAME[settings.provider] ?? 'the AI service you set up'
  return (
    <div className="notice ask first-call" role="alert" aria-label="Before your first call">
      <span>
        <strong>Before your first call.</strong> The rules for writing down a call differ by place, and in some places everyone on it has to agree. Togle gives you a line to tell the others. The words of the call go to {ai} so it can write the notes. {here ? 'The sound stays on this computer.' : 'The sound goes to the speech service you chose in Settings.'}
      </span>
      <div className="row">
        <button className="primary" autoFocus onClick={onDone}>Got it</button>
      </div>
    </div>
  )
}
