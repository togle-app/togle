import { app, safeStorage } from 'electron'
import type { TogleAccountState } from '@shared/togle-account'
import { accountConfig, type AccountConfig } from './account-config'
import { StudioAccount, type StudioSession } from './reach/studio-account'
import { readSecret, writeSecret } from './storage'

declare const __TOGLE_ACCOUNT_CONFIG__: AccountConfig | undefined
const secretFile = 'studio-account.bin' // Existing development installations keep their sign-in.
type Handle = (channel: string, action: (...args: unknown[]) => unknown) => void

export function registerTogleAccount(handle: Handle, changed: () => void): StudioAccount | undefined {
  const release = __TOGLE_ACCOUNT_CONFIG__
  const devUrl = process.env.TOGLE_ACCOUNT_SUPABASE_URL || process.env.TOGLE_STUDIO_SUPABASE_URL
  const devKey = process.env.TOGLE_ACCOUNT_SUPABASE_KEY || process.env.TOGLE_STUDIO_SUPABASE_KEY
  let config: AccountConfig | undefined
  let problem = 'Account sign-in is unavailable in this build. You can use Togle on this computer.'
  try { config = !app.isPackaged && (devUrl || devKey) ? accountConfig(devUrl, devKey, true) : release }
  catch { problem = 'The account service settings are incomplete. Check the Togle account URL and public key.' }
  const secure = () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  const account = config && new StudioAccount({
    url: config.url, publicKey: config.publicKey, changed,
    store: {
      read: () => secure() ? readSecret<StudioSession>(secretFile) : Promise.resolve(null),
      write: session => {
        if (session && !secure()) throw new Error('Unlock a system keyring to save your Togle account.')
        return writeSecret(secretFile, session)
      }
    }
  })
  const requireAccount = () => {
    if (!account) throw new Error(problem)
    if (!secure()) throw new Error('Unlock a system keyring to sign in to your Togle account.')
    return account
  }
  handle('togle-account:state', async (): Promise<TogleAccountState> => {
    if (!account) return { available: false, problem }
    if (!secure()) return { available: false, problem: 'Unlock a system keyring to sign in to your Togle account.' }
    await account.load()
    const who = account.who()
    return { available: true, ...(who && { user: { id: who.user, email: who.email } }) }
  })
  handle('togle-account:send-code', (email) => requireAccount().sendCode(typeof email === 'string' ? email : ''))
  handle('togle-account:sign-in', (email, code) => requireAccount().verify(typeof email === 'string' ? email : '', typeof code === 'string' ? code : ''))
  handle('togle-account:sign-out', () => requireAccount().signOut())
  handle('togle-account:waitlist', (user, action) => {
    if (typeof user !== 'string' || (action !== 'status' && action !== 'join' && action !== 'leave')) throw new Error('Choose a waitlist action.')
    return requireAccount().waitlist(user, action)
  })
  return account
}
