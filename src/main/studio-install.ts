import path from 'node:path'
import type { MicrophoneLaunch } from '@shared/microphone-link'

/** The name macOS knows Togle Studio by: its bundle identifier. */
const BUNDLE_ID = 'io.togle.studio'

export interface InstallLookup {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** The person's home folder. */
  home: string
  /** Whether a file or folder is there. */
  exists: (file: string) => boolean
}

/**
 * Where Togle Studio is on this computer, if it is: the program its installer put there, and how to start it. This asks
 * the computer, not what the app wrote while it ran. Its link file outlives it (an app that was removed, a copy run from
 * source) and does not exist yet for an app that never ran, so only the installed program tells the truth.
 *
 * The places are the ones its installer uses: a Windows installer for every user (Program Files), or for one (the
 * person's Programs folder); `/Applications` or the person's own on a Mac; a .deb on Linux. An AppImage lives wherever
 * it was put, so only its link file knows it.
 */
export function installedStudio({ platform, env, home, exists }: InstallLookup): MicrophoneLaunch | undefined {
  const quiet = ['--hidden']
  if (platform === 'win32') {
    const places = [env.ProgramW6432, env.ProgramFiles, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
    for (const place of places) {
      if (!place) continue
      const program = path.win32.join(place, 'Togle Studio', 'Togle Studio.exe')
      if (exists(program)) return { command: program, args: quiet }
    }
    return undefined
  }
  if (platform === 'darwin') {
    for (const place of ['/Applications', path.posix.join(home, 'Applications')]) {
      if (exists(path.posix.join(place, 'Togle Studio.app', 'Contents', 'MacOS'))) return { command: '/usr/bin/open', args: ['-b', BUNDLE_ID, '--args', ...quiet] }
    }
    return undefined
  }
  for (const program of ['/opt/Togle Studio/togle-studio', '/usr/bin/togle-studio', '/usr/local/bin/togle-studio']) {
    if (exists(program)) return { command: program, args: quiet }
  }
  return undefined
}
