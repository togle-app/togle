import { useEffect, useState } from 'react'
import type { TogleAccountState } from '@shared/togle-account'
import { Field, FormOver, Row, useOneOpen } from './Rows'
import { Opens } from './Choice'
import { Menu } from './Menu'

const api = window.togle
type Run = (name: string, work: () => Promise<unknown>) => Promise<void>
const errorText = (failure: unknown): string => (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function TogleAccountRow() {
  const [account, setAccount] = useState<TogleAccountState>()
  const [signingIn, setSigningIn] = useOneOpen()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let version = 0
    const read = () => {
      const current = ++version
      void api.togleAccountState().then(state => {
        if (active && current === version) setAccount(state)
      }, failure => { if (active && current === version) setError(errorText(failure)) })
    }
    const off = api.onTogleAccountChanged(read)
    read()
    return () => { active = false; off() }
  }, [])
  const run: Run = async (name, work) => {
    setBusy(name); setError('')
    try { await work() } catch (failure) { setError(errorText(failure)) } finally { setBusy('') }
  }
  return <>
    <Row label={false} name="Togle account" note={account?.problem}>
      {account?.available && !account.user && <span className="setting-value">Pro waitlist</span>}
      {account?.user
        ? <Menu className="choice" label={<Opens>{account.user.email}</Opens>} ariaLabel="Togle account" align="right" items={[{ label: 'Sign out', disabled: !!busy, onSelect: () => void run('out', () => api.togleAccountSignOut()) }]} />
        : account?.available && <button className="small" aria-label="Sign in to your Togle account" aria-expanded={signingIn} onClick={() => setSigningIn(!signingIn)}>Sign in</button>}
    </Row>
    {signingIn && account?.available && !account.user && <SignIn busy={busy} error={error} run={run} onCancel={() => { setSigningIn(false); setError('') }} />}
    {error && !signingIn && <p className="error" role="alert">{error}</p>}
    {account?.user && <Waitlist key={account.user.id} user={account.user.id} />}
  </>
}

function Waitlist({ user }: { user: string }) {
  const [joined, setJoined] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api.proWaitlist(user, 'status').then(value => { if (active) setJoined(value) }, failure => {
      if (active) setError(errorText(failure))
    })
    return () => { active = false }
  }, [user])
  const change = async () => {
    setBusy(true); setError('')
    try { setJoined(await api.proWaitlist(user, joined === undefined ? 'status' : joined ? 'leave' : 'join')) }
    catch (failure) { setJoined(undefined); setError(errorText(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <Row label={false} name="Togle Pro" note={joined ? 'You’re on the waitlist.' : 'Get an email when Pro is available. Planned features include managing agents across computers from your phone, microphone cleanup and meeting recording in Togle Studio.'}>
      {(joined !== undefined || error) && <button className="small" disabled={busy} onClick={() => void change()}>{joined === undefined ? 'Retry' : joined ? 'Leave waitlist' : 'Join waitlist'}</button>}
    </Row>
    {error && <p className="error" role="alert">{error}</p>}
  </>
}

/** Signing in with a code sent by email: device enrollment is a separate action. */
function SignIn({ busy, error, run, onCancel }: { busy: string; error: string; run: Run; onCancel: () => void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const submit = (): void => {
    if (!sent) void run('send', async () => { await api.togleAccountSendCode(email); setSent(true) })
    else void run('verify', async () => { await api.togleAccountSignIn(email, code); onCancel() })
  }
  return (
    <FormOver label="Sign in to your Togle account" busy={!!busy} onClose={onCancel} onSubmit={submit}>
      <span className="tasks-label">Sign in to your Togle account</span>
      <Field name={sent ? 'Code' : 'Email'} note={sent ? <>A code is on its way to <span className="free-text">{email}</span>. Enter it here.</> : 'Use the email for your Togle account, or enter one to create it. After signing in, you can join the Pro waitlist. Local tools work without an account.'}>
        {sent
          ? <input aria-label="Code from the email" inputMode="numeric" autoComplete="one-time-code" maxLength={10} autoFocus value={code} disabled={!!busy} onChange={(event) => setCode(event.target.value)} />
          : <input aria-label="Email address" type="email" autoComplete="email" maxLength={200} value={email} disabled={!!busy} onChange={(event) => setEmail(event.target.value)} />}
      </Field>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" disabled={!!busy || (sent ? code.replace(/\s/g, '').length < 6 : !email.includes('@'))}>
          {busy === 'send' ? 'Sending…' : busy === 'verify' ? 'Signing in…' : sent ? 'Sign in' : 'Email me a code'}
        </button>
        {sent && <button type="button" className="ghost" disabled={!!busy} onClick={() => void run('resend', async () => { await api.togleAccountSendCode(email); setCode('') })}>{busy === 'resend' ? 'Sending…' : 'Resend code'}</button>}
        {sent && <button type="button" className="ghost" disabled={!!busy} onClick={() => { setSent(false); setCode('') }}>Use another address</button>}
        <button type="button" className="ghost" disabled={!!busy} onClick={onCancel}>Cancel</button>
      </div>
    </FormOver>
  )
}
