import { useEffect, useState } from 'react'
import type { SettingsPatch } from '@shared/api'
import type { DictationState } from '@shared/dictation'
import { dictationSource } from '@shared/dictation'
import type { Settings } from '@shared/types'
import { useHotkeys } from './hotkeys'
import { Row, Section, Toggle } from './Rows'
import { Shortcut } from './Shortcut'
import { useAccounts } from './Accounts'
import { DictationVocabulary } from './DictationVocabulary'
import { DictationHistory } from './DictationHistory'

export function DictationSettings({ settings, save, agent = false }: { settings: Settings; save: (patch: SettingsPatch) => Promise<unknown>; agent?: boolean }) {
  const shortcut = useHotkeys().find(key => key.id === 'dictate')
  const accounts = useAccounts()
  const [state, setState] = useState<DictationState>({ phase: 'idle' })
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [deviceError, setDeviceError] = useState('')
  useEffect(() => {
    let live = true, generation = 0
    const media = navigator.mediaDevices
    const refresh = async (): Promise<void> => {
      const request = ++generation
      try {
        const devices = await media.enumerateDevices()
        if (!live || request !== generation) return
        setMicrophones(devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default'))
        setDeviceError('')
      } catch { if (live && request === generation) setDeviceError('Device names may appear after your first dictation. System default still works.') }
    }
    void refresh()
    media?.addEventListener('devicechange', refresh)
    window.addEventListener('focus', refresh)
    return () => { live = false; media?.removeEventListener('devicechange', refresh); window.removeEventListener('focus', refresh) }
  }, [])
  useEffect(() => {
    let live = true, received = false
    const off = window.togle.onDictation(value => { received = true; setState(value); setCopied(false); setCopyError('') })
    void window.togle.dictationStatus().then(value => { if (live && !received) setState(value) })
    return () => { live = false; off() }
  }, [])
  const account = accounts.accounts.find(account => account.id === (settings.dictation.accountId || settings.transcription.accountId || accounts.globalId))
  const source = account?.provider ?? dictationSource(settings)
  const subscription = source === 'claude' ? 'Claude' : source === 'chatgpt' ? 'ChatGPT' : undefined
  const keys = shortcut?.keys || 'your shortcut'
  return <Section id={agent ? 'agent-dictation' : 'settings-dictation'} title="Voice typing">
    <p className="dictation-instruction">{window.togle.platform === 'darwin' ? <>Press <kbd>{keys}</kbd> to speak, then again to finish. Use Copy text to paste into any text box.</> : settings.dictation.mode === 'hold' ? <>Hold <kbd>{keys}</kbd> to speak. Release to type into any text box.</> : <>Press <kbd>{keys}</kbd> to speak, then again to type into any text box.</>}<span>Esc cancels. Messages stay unsent.</span></p>
    <Toggle name="Show voice bar" checked={settings.dictation.showBar} onChange={showBar => void save({ dictation: { showBar } })}
      note="A small bar shows listening and processing." />
    <Toggle name="Clean up my words" checked={settings.dictation.polish} onChange={polish => void save({ dictation: { polish } })}
      note={subscription ? `${subscription} adds punctuation and removes fillers. Turn off for faster typing.` : 'Adds punctuation and removes fillers with the speech account.'} />
    <details className="more voice-options"><summary>Microphone &amp; shortcut</summary>
    {shortcut && !agent && <Shortcut hotkey={shortcut} />}
    {window.togle.platform === 'darwin' && <p className="hint">You may need Fn with F9 on Mac, or choose another shortcut above.</p>}
    <Row name="Shortcut behavior"><select aria-label="Dictation shortcut behavior" value={settings.dictation.mode} onChange={event => void save({ dictation: { mode: event.target.value as 'hold' | 'toggle' } })}>
      {window.togle.platform === 'win32' && <option value="hold">Hold to speak</option>}<option value="toggle">Press to start / stop</option>
    </select></Row>
    <Row name="Microphone" note={deviceError || (state.phase === 'recording' ? 'Changes apply the next time you start dictation.' : 'Choose your headset or use the system default. This only affects dictation.')}>
      <select aria-label="Dictation microphone" value={settings.dictation.microphoneId} onChange={event => void save({ dictation: { microphoneId: event.target.value } })}>
        <option value="">System default</option>
        {settings.dictation.microphoneId && !microphones.some(device => device.deviceId === settings.dictation.microphoneId) && <option value={settings.dictation.microphoneId}>Saved microphone (not listed)</option>}
        {microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
      </select>
    </Row>
    </details>
    {account && <DictationVocabulary key={account.id} accountId={account.id} accountName={account.label} />}
    {account && <DictationHistory key={account.id + '-history'} accountId={account.id} accountName={account.label} />}
    {state.lastText && <Row label={false} name="Last dictation" note="Available until you quit Togle. Recent dictations are saved only when you turn history on for the account.">
      <button className="ghost" onClick={() => { setCopyError(''); void window.togle.copyDictationText().then(() => setCopied(true), () => setCopyError('Could not copy. Your text is still available; try again.')) }}>{copied ? 'Copied' : 'Copy last text'}</button>
    </Row>}
    {copyError && <p className="error" role="alert">{copyError}</p>}
  </Section>
}
