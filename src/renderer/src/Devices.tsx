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

/** Enable this computer, pair it with an existing group, or replace a lost first computer. */
function NotYet({ reach, busy, run }: PartProps) {
  const [recovering, setRecovering] = useOneOpen()
  const [recoveryKey, setRecoveryKey] = useState('')
  const cancelRecovery = (): void => { setRecovering(false); setRecoveryKey('') }
  if (reach.accountPaused) return <Row label={false} name="Remote access is paused" note="Sign in under Accounts with the Togle account that connected this computer." />
  if (reach.code) return <ShowingCode reach={reach} busy={busy} run={run} />
  const connecting = reach.link === 'connecting'
  return (
    <>
      {reach.account ? (
        <Row label={false} name="Enable remote access" note="Use this computer to manage a new group and share its agent sessions.">
          <button className="small" disabled={!!busy || connecting} onClick={() => void run('connect', () => api.reachConnect())}>{busy === 'connect' || connecting ? 'Enabling…' : 'Enable remote access'}</button>
        </Row>
      ) : <Row label={false} name="Enable remote access" note="Sign in under Accounts to set up this computer." />}
      <Row label={false} name="Join your devices" note={reach.standing === 'removed' ? 'This computer was removed. Pair it again to regain access.' : 'Enter this computer’s code on the computer that manages your group.'}>
        <button className="ghost small" disabled={!!busy} onClick={() => void run('code', () => api.reachShowCode())}>{busy === 'code' ? 'Getting a code…' : 'Show a code'}</button>
      </Row>
      {reach.account && (
        <Row label={false} name="Recover your devices" note="Use your saved recovery key to replace a lost managing computer.">
          <button className="ghost small" disabled={!!busy || connecting} onClick={() => setRecovering(true)}>Use recovery key</button>
        </Row>
      )}
      {recovering && (
        <FormOver label="Recover your devices" busy={!!busy} onClose={cancelRecovery} onSubmit={() => {
          const key = recoveryKey.trim()
          setRecoveryKey('')
          void run('recover', async () => { await api.reachStartAgain(key); cancelRecovery() })
        }}>
          <Field name="Recovery key" note="Recovery disconnects the previous group. You can pair the devices you still use again from here.">
            <input type="password" aria-label="Recovery key" autoComplete="off" spellCheck={false} maxLength={120} value={recoveryKey} onChange={event => setRecoveryKey(event.target.value)} />
          </Field>
          <div className="row">
            <button className="primary" disabled={!!busy || !recoveryKey.trim()}>{busy === 'recover' ? 'Recovering…' : 'Recover'}</button>
            <button type="button" className="ghost" disabled={!!busy} onClick={cancelRecovery}>Cancel</button>
          </div>
        </FormOver>
      )}
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
  const manages = reach.canManageDevices === true
  return (
    <>
      <Row label={false} name="Connection" note={connectionWords(reach)} />
      {reach.devices.map((device) => (
        <Row key={device.device} label={false} name={<span className="reach-device"><span className={`reach-dot ${device.online ? 'on' : ''}`} aria-hidden="true" /><span className="free-text">{device.name}</span></span>} note={device.me ? 'This computer' : `${ROLE_WORDS[device.role]}${device.online ? '' : ' · offline'}`}>
          {!device.me && manages && (
            <button className="quiet-action" aria-label={`Remove ${device.name}`} disabled={!!busy} onClick={() => void run(`remove-${device.device}`, () => api.reachRemove(device.device))}>
              {busy === `remove-${device.device}` ? 'Removing…' : 'Remove'}
            </button>
          )}
        </Row>
      ))}
      <Toggle name="Other devices may act on this computer" note={reach.phonePilot ? 'Paired computers can refuse or stop a task. Paired computers and phones can select a listed answer to an eligible Codex question. Turn this off for view-only access.' : 'Refuse a request or stop a task here from your other devices. Off, they can only look.'} checked={reach.actOnThis} disabled={!!busy} onChange={(on) => void run('act', () => api.reachActOnThis(on))} />
      {manages && <AddDevice reach={reach} busy={busy} run={run} />}
      {manages && reach.account && <SaveRecoveryKey key={reach.me?.device} reach={reach} busy={busy} run={run} />}
      {!!reach.acted.length && (
        <Row label={false} name="Done here from other devices" note={
          <span className="reach-acted">{reach.acted.slice(0, 5).map((item) => <span key={`${item.at}-${item.device}`}>{new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {item.name}: {item.what}</span>)}</span>
        } />
      )}
      {reach.account && (
        <Row label={false} name={<>Togle account · <span className="free-text">{reach.account.email}</span></>} note="Signing out pauses remote access on this computer. Sign back in to resume.">
          <button className="ghost small" disabled={!!busy} onClick={() => void run('out', () => api.reachSignOut())}>Sign out</button>
        </Row>
      )}
    </>
  )
}

function SaveRecoveryKey({ reach, busy, run }: PartProps) {
  const [copied, setCopied] = useState(false)
  return <Row label={false} name="Recovery key" note={copied ? 'Copied. Paste it into your password manager.' : 'Save a backup in your password manager in case you lose this computer.'}>
    <button className="ghost small" disabled={!!busy || reach.link !== 'member'} onClick={() => void run('copy-recovery', async () => { await api.reachCopyRecovery(); setCopied(true) })}>Copy recovery key</button>
  </Row>
}

function PairingInvite({ invite, busy, cancel }: { invite: NonNullable<ReachState['invite']>; busy: boolean; cancel: () => void }) {
  const [image, setImage] = useState<{ code: string; url: string }>()
  const [failed, setFailed] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  useEffect(() => {
    if (invite.joined) return
    let active = true
    void import('qrcode').then(qr => qr.toDataURL(invite.code, { width: 200, margin: 4 })).then(
      url => { if (active) setImage({ code: invite.code, url }) },
      () => { if (active) setFailed(true) }
    )
    return () => { active = false }
  }, [invite.code, invite.joined])
  return (
    <div className="setting stacked reach-code" role="group" aria-label="Phone pairing invitation">
      <span className="name">Pair your phone</span>
      {invite.joined ? <span className="note">Checking the phone…</span> : (
        <>
          <span className="note">In Togle on your phone, sign in and choose Scan QR code.</span>
          {image?.code === invite.code && <img src={image.url} alt="One-time Togle pairing QR code" width={200} height={200} />}
          {failed && <span className="note" role="status">The QR code could not open. You can copy the invitation instead.</span>}
          <span className="note">To pair without a camera, copy the invitation and paste it into Togle on your own phone.</span>
          <span className="control"><button className="ghost small" disabled={busy} onClick={() => {
            void navigator.clipboard.writeText(invite.code).then(() => setCopyStatus('Invitation copied.'), () => setCopyStatus('Could not copy the invitation.'))
          }}>Copy invitation</button></span>
          <span className="note" role="status">{copyStatus}</span>
        </>
      )}
      <span className="control"><button className="ghost small" disabled={busy} onClick={cancel}>Cancel</button></span>
    </div>
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
          <span className="note">{adding.name} {adding.role === 'phone' && reach.phonePilot ? 'joins as a phone. It can see eligible Codex questions and select a listed answer.' : JOINS_AS[adding.role ?? 'computer']}</span>
        <span className="control row">
          <button className="primary" disabled={!!busy || adding.stage === 'adding'} onClick={() => void run('confirm', () => api.reachConfirmAdd())}>{adding.stage === 'adding' ? 'Adding…' : 'Add'}</button>
          <button className="ghost" disabled={!!busy || adding.stage === 'adding'} onClick={() => void run('cancel-add', () => api.reachCancelAdd())}>Cancel</button>
        </span>
      </div>
    )
  }
  const shown = open || adding?.stage === 'joining'
  const cancel = (): void => { setOpen(false); if (adding) void run('cancel-add', () => api.reachCancelAdd()) }
  if (reach.invite) return <PairingInvite key={reach.invite.code} invite={reach.invite} busy={!!busy} cancel={cancel} />
  // The row stays where it is while its form is open under it, over the page.
  return (
    <>
      <Row label={false} name="Add a device" note={adding?.stage === 'added' ? `${adding.name} was added.` : adding?.stage === 'failed' ? adding.message : 'Show a QR code for your phone or enter the code from another computer or server.'}>
        <div className="row">
          <button className="small" disabled={!!busy || !!shown || reach.connection !== 'on' || reach.link !== 'member'} onClick={() => void run('invite', () => api.reachInvite())}>Show QR code</button>
          <button className="ghost small" aria-expanded={shown} disabled={!!busy || reach.connection !== 'on' || reach.link !== 'member'} onClick={() => { if (shown) cancel(); else { setCode(''); setOpen(true) } }}>Enter a code</button>
        </div>
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
