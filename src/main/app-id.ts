import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { betaBuild, betaProfile } from './release-channel'

/**
 * The id Windows knows Togle by (the application user model id). It groups Togle's windows on the taskbar, and a notification and the
 * Start menu take Togle's name and icon from the Start menu shortcut that carries it. So an id can belong to one app only: if a second
 * shortcut carries it, Windows may pick that one and show its name and icon instead.
 *
 * The installed app has the builder's `appId`, and its shortcut carries it. Togle run from the source, a test or a preview is Electron's
 * own exe: with the installed app's id it took the id for itself (a Start menu entry "Electron" held it, and the installed Togle showed
 * Electron's name and icon), so it has an id of its own.
 */
export const APP_ID = betaBuild ? 'io.togle.app.beta' : 'io.togle.app'

export const appUserModelId = (packaged: boolean): string => (packaged ? APP_ID : `${APP_ID}.source`)

export const TOAST_ACTIVATOR = betaBuild ? '{F35B2FFB-B9CC-42BE-A01A-85FDEE820394}' : '{38D38FEF-DC19-4C9F-A11D-30B1AC603BD9}'

if (betaBuild && app?.isPackaged) {
  const folder = path.join(app.getPath('appData'), betaProfile)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  app.setName('Togle Beta')
  app.setPath('userData', folder)
}
