/**
 * The id Windows knows Togle by (the application user model id). It groups Togle's windows on the taskbar, and a notification and the
 * Start menu take Togle's name and icon from the Start menu shortcut that carries it. So an id can belong to one app only: if a second
 * shortcut carries it, Windows may pick that one and show its name and icon instead.
 *
 * The installed app has the builder's `appId`, and its shortcut carries it. Togle run from the source, a test or a preview is Electron's
 * own exe: with the installed app's id it took the id for itself (a Start menu entry "Electron" held it, and the installed Togle showed
 * Electron's name and icon), so it has an id of its own.
 */
export const APP_ID = 'io.togle.app'

export const appUserModelId = (packaged: boolean): string => (packaged ? APP_ID : `${APP_ID}.source`)
