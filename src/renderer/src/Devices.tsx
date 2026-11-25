import { useEffect, useState } from 'react'
import type { ReachDevice, ReachState } from '@shared/reach'
import { Field, FormOver, Row, Section, Toggle, useOneOpen } from './Rows'

// Settings → Devices: view and manage the devices connected through Togle Pro.

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ROLE_WORDS: Record<ReachDevice['role'], string> = {
  computer: 'A computer you sit at',
  server: 'A server · runs agents only',
  phone: 'A phone'
}
const JOINS_AS: Record<ReachDevice['role'], string> = {
  computer: 'joins as a computer you sit at. It can see and answer the agents on your other computers.',
  server: 'joins as a server. It runs agents only, and can’t see or answer your other devices.',
  phone: 'joins as a phone. It sees your lists and can refuse and stop. Typing to agents stays off.'
}

/** Reach's state, kept current. */
export function useReach(): ReachState | null {
  const [state, setState] = useState<ReachState | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => { void api.reachState().then((value) => { if (live) setState(value) }, () => undefined) }
    read()
    const off = api.onReachChanged(read)
    // A code's time left, and devices coming and going, without a message for each second.
    const timer = setInterval(read, 5_000)
    return () => { live = false; off(); clearInterval(timer) }
  }, [])
  return state
}

export function Devices() {
  const reach = useReach()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  if (!reach?.available) return null
  const run = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(what); setError('')
    try { await work() } catch (failure) { setError(errorText(failure)) } finally { setBusy('') }
  }
  const member = reach.standing === 'member'
  return (
    <Section id="settings-devices" title="Devices">
      {member ? <Member reach={reach} busy={busy} run={run} /> : <NotYet reach={reach} busy={busy} run={run} />}
      {reach.problem && <p className="error" role="alert">{reach.problem}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  )
}

interface PartProps { reach: ReachState; busy: string; run: (what: string, work: () => Promise<unknown>) => Promise<void> }

/** Not one of the person's devices yet: connect this computer after signing in, or show a code to add it from one they use. */
function NotYet({ reach, busy, run }: PartProps) {
  if (reach.code) return <ShowingCode reach={reach} busy={busy} run={run} />
  const showCode = <button className="ghost small" disabled={!!busy} onClick={() => void run('code', () => api.reachShowCode())}>{busy === 'code' ? 'Getting a code…' : 'Show a code'}</button>
  if (reach.standing === 'removed') {
    return <Row label={false} name="This computer was removed from your devices" note="Or your devices started again from another computer. To add it again, show its code and type it into a computer you use.">{showCode}</Row>
  }
  if (reach.addFromAnother) {
    return (
      <>
        <Row label={false} name="Your account has devices already" note="Add this computer from one of them: show its code here, then type it there in Settings → Devices → Add a device.">{showCode}</Row>
        <Row label={false} name="Lost your only computer?" note="Start your devices again from this one. Your other devices are let go, and you add them again from here. Nothing on them is lost.">
          <button className="ghost small" disabled={!!busy} onClick={() => void run('again', () => api.reachStartAgain())}>{busy === 'again' ? 'Starting…' : 'Start again'}</button>
        </Row>
      </>
    )
  }
  return (
    <>
      {reach.account && <Row label={false} name="Connect this computer" note="Connect it to your Togle account to share its agent tasks with your trusted devices.">
        <button className="small" disabled={!!busy || reach.link === 'connecting'} onClick={() => void run('connect', () => api.reachConnect())}>{reach.link === 'connecting' ? 'Connecting…' : 'Connect this computer'}</button>
      </Row>}
      <Row label={false} name="Add this computer from one you use" note={reach.account ? undefined : 'To start your devices here, sign in to your Togle account under Accounts.'}>{showCode}</Row>
    </>
  )
}

/** This device's code, to type into a computer of the group: it works once, for a few minutes. */
function ShowingCode({ reach, busy, run }: PartProps) {
  const code = reach.code!
  const left = Math.max(0, Math.round((code.expiresAt - Date.now()) / 60_000))
  return (
    <div className="setting stacked reach-code" role="group" aria-label="This computer's code">
      <span className="name">This computer’s code</span>
      <strong className="reach-code-value" aria-live="polite">{code.code}</strong>
      <span className="note">
        {code.joined ? 'A computer is adding this one. Answer there.' : `Type it into Togle on a computer you use: Settings → Devices → Add a device. It works once${left ? `, for ${left} more minute${left === 1 ? '' : 's'}` : ''}.`}
      </span>
      {code.problem && <span className="note">{code.problem}</span>}
      <span className="control"><button className="ghost small" disabled={!!busy} onClick={() => void run('cancel', () => api.reachCancelCode())}>Cancel</button></span>
    </div>
  )
}

/** One of the person's devices: the connection, the list with Remove, what others may do here, and adding a device. */
function Member({ reach, busy, run }: PartProps) {
  const isComputer = reach.me?.role === 'computer'
  return (
    <>
      <Row label={false} name="Connection" note={connectionWords(reach)} />
      {reach.devices.map((device) => (
        <Row key={device.device} label={false} name={<span className="reach-device"><span className={`reach-dot ${device.online ? 'on' : ''}`} aria-hidden="true" /><span className="free-text">{device.name}</span></span>} note={device.me ? 'This computer' : `${ROLE_WORDS[device.role]}${device.online ? '' : ' · offline'}`}>
          {!device.me && isComputer && (
            <button className="quiet-action" aria-label={`Remove ${device.name}`} disabled={!!busy} onClick={() => void run(`remove-${device.device}`, () => api.reachRemove(device.device))}>
              {busy === `remove-${device.device}` ? 'Removing…' : 'Remove'}
            </button>
          )}
        </Row>
      ))}
      <Toggle name="Other devices may act on this computer" note={reach.phonePilot ? 'Your paired phone can select a listed answer to a Codex question. Your devices can also refuse a request or stop a task. Turn this off for view-only access.' : 'Refuse a request or stop a task here from your other devices. Off, they can only look.'} checked={reach.actOnThis} disabled={!!busy} onChange={(on) => void run('act', () => api.reachActOnThis(on))} />
      {isComputer && <AddDevice reach={reach} busy={busy} run={run} />}
      {!!reach.acted.length && (
        <Row label={false} name="Done here from other devices" note={
          <span className="reach-acted">{reach.acted.slice(0, 5).map((item) => <span key={`${item.at}-${item.device}`}>{new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {item.name}: {item.what}</span>)}</span>
        } />
      )}
      {reach.account && (
        <Row label={false} name={<>Togle account · <span className="free-text">{reach.account.email}</span></>} note="Signing out leaves this computer one of your devices.">
          <button className="ghost small" disabled={!!busy} onClick={() => void run('out', () => api.reachSignOut())}>Sign out</button>
        </Row>
      )}
    </>
  )
}

function connectionWords(reach: ReachState): string {
  if (reach.link === 'member') {
    if (reach.connection === 'needs-pro') return 'Connect your devices with Togle Pro.'
    if (reach.connection === 'off') return 'The device connection is off for your Togle account.'
    return 'Your device connection is on.'
  }
  if (reach.link === 'refused') return 'This computer couldn’t connect to your devices.'
  return 'Not connected right now. Togle keeps working on this computer, and shows the others as offline.'
}

/** Add a device: type the code it shows, read what joins and as what, then say yes. */
function AddDevice({ reach, busy, run }: PartProps) {
  const [code, setCode] = useState('')
  const [open, setOpen] = useOneOpen()
  const adding = reach.adding
  if (adding?.stage === 'confirm' || adding?.stage === 'adding') {
    return (
      <div className="setting stacked" role="group" aria-label="Add this device?">
        <span className="name">Add {adding.name}?</span>
        <span className="note">{adding.name} {adding.role === 'phone' && reach.phonePilot ? 'joins as a phone. It can see tasks, choose a listed answer to a Codex question, refuse a request or stop a task.' : JOINS_AS[adding.role ?? 'computer']}</span>
        <span className="control row">
          <button className="primary" disabled={!!busy || adding.stage === 'adding'} onClick={() => void run('confirm', () => api.reachConfirmAdd())}>{adding.stage === 'adding' ? 'Adding…' : 'Add'}</button>
          <button className="ghost" disabled={!!busy || adding.stage === 'adding'} onClick={() => void run('cancel-add', () => api.reachCancelAdd())}>Cancel</button>
        </span>
      </div>
    )
  }
  const shown = open || adding?.stage === 'joining'
  const cancel = (): void => { setOpen(false); if (adding) void run('cancel-add', () => api.reachCancelAdd()) }
  // The row stays where it is while its form is open under it, over the page.
  return (
    <>
      <Row label={false} name="Add a device" note={adding?.stage === 'added' ? `${adding.name} was added.` : adding?.stage === 'failed' ? adding.message : 'Install Togle there. It shows a code: type it here.'}>
        <button className="ghost small" aria-expanded={shown} disabled={!!busy || reach.connection !== 'on' || reach.link !== 'member'} onClick={() => { if (shown) cancel(); else { setCode(''); setOpen(true) } }}>Add a device</button>
      </Row>
      {shown && (
        <FormOver label="Add a device" busy={!!busy} onClose={cancel} onSubmit={() => void run('add', async () => { await api.reachAdd(code); setOpen(false) })}>
          <span className="tasks-label">Add a device</span>
          <Field name="Its code" note={adding?.stage === 'joining' ? 'Checking the code with the other device…' : 'The other device shows it: eight letters and digits, like 7F3K-92QD.'}>
            <input aria-label="Code" maxLength={12} spellCheck={false} autoComplete="off" value={code} disabled={!!busy || adding?.stage === 'joining'} onChange={(event) => setCode(event.target.value.toUpperCase())} />
          </Field>
          <div className="row">
            <button className="primary" disabled={!!busy || code.replace(/[\s-]/g, '').length !== 8}>{busy === 'add' ? 'Checking…' : 'Next'}</button>
            <button type="button" className="ghost" disabled={!!busy} onClick={cancel}>Cancel</button>
          </div>
        </FormOver>
      )}
    </>
  )
}
