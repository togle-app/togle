// Which program is in front, and whether it is a code editor that uses F8, F9 or F10 itself (for its debugger): the first
// time one of Togle's keys is pressed there, Togle offers once to change its keys. On Windows the program's file is read
// through user32; on a Mac the app's bundle id through lsappinfo (no permission is asked for it); on Linux the window's
// class through xprop (X11, and XWayland). The Mac and Linux ways were not tried on those systems yet.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import koffi from 'koffi'

// JetBrains IDEs, by the name of their program without "64" and ".exe".
const JETBRAINS: Readonly<Record<string, string>> = {
  idea: 'IntelliJ IDEA', pycharm: 'PyCharm', webstorm: 'WebStorm', phpstorm: 'PhpStorm', rider: 'Rider', clion: 'CLion', goland: 'GoLand',
  rubymine: 'RubyMine', datagrip: 'DataGrip', dataspell: 'DataSpell', rustrover: 'RustRover', aqua: 'Aqua', writerside: 'Writerside', studio: 'Android Studio'
}
// Visual Studio, and VS Code with the editors made from it, which keep its keys.
const EDITORS: Readonly<Record<string, string>> = {
  code: 'VS Code', 'code - insiders': 'VS Code', codium: 'VSCodium', vscodium: 'VSCodium', cursor: 'Cursor', windsurf: 'Windsurf', devenv: 'Visual Studio'
}

/** The code editor a program is, by its name as the person knows it, or undefined for any other program. */
export function codeEditorOf(program: string): string | undefined {
  const name = path.win32.basename(path.posix.basename(program)).toLowerCase().replace(/\.exe$/, '')
  return EDITORS[name] ?? JETBRAINS[name.replace(/64$/, '')]
}

// On a Mac, by bundle id: VS Code and the editors made from it, and Android Studio (JetBrains' are com.jetbrains.<name>).
const MAC_EDITORS: Readonly<Record<string, string>> = {
  'com.microsoft.vscode': 'VS Code', 'com.microsoft.vscodeinsiders': 'VS Code', 'com.vscodium': 'VSCodium', 'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf', 'com.google.android.studio': 'Android Studio'
}

/** The code editor a Mac app is, by its bundle id ("com.microsoft.VSCode", "com.jetbrains.pycharm.ce"). */
export function macEditorOf(bundleId: string): string | undefined {
  const id = bundleId.trim().toLowerCase()
  const jetbrains = /^com\.jetbrains\.([a-z]+)/.exec(id)?.[1]
  return MAC_EDITORS[id] ?? (jetbrains ? JETBRAINS[jetbrains === 'intellij' ? 'idea' : jetbrains] : undefined)
}

/** The code editor a Linux window is, by one of its classes ("code", "jetbrains-pycharm-ce"). */
export function linuxEditorOf(windowClass: string): string | undefined {
  const name = windowClass.trim().toLowerCase()
  if (name === 'code - insiders' || name === 'code-insiders') return 'VS Code'
  const jetbrains = /^jetbrains-([a-z]+)/.exec(name)?.[1]
  return EDITORS[name] ?? (jetbrains ? JETBRAINS[jetbrains] : undefined)
}

/** The bundle id `lsappinfo info -only bundleid` printed: "CFBundleIdentifier"="com.microsoft.VSCode". */
export const lsappinfoBundle = (output: string): string | undefined => /"CFBundleIdentifier"\s*=\s*"([^"]+)"/.exec(output)?.[1]

/** The window `xprop -root _NET_ACTIVE_WINDOW` printed as active, if one is: "window id # 0x3a00007". */
export const xpropActiveWindow = (output: string): string | undefined => {
  const id = /window id # (0x[0-9a-f]+)/i.exec(output)?.[1]
  return id && !/^0x0+$/i.test(id) ? id : undefined
}

/** The classes `xprop -id <window> WM_CLASS` printed: WM_CLASS(STRING) = "code", "Code". */
export const xpropClasses = (output: string): string[] => [...output.matchAll(/"([^"]*)"/g)].map((match) => match[1]).filter(Boolean)

/** What a small program prints, given half a second at most: the press of a key waits on it. */
const quick = (file: string, args: string[]): string => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** The code editor in front, as the person knows it ("VS Code"), or undefined when it is not one or cannot be told. */
export function frontEditor(): string | undefined {
  if (process.platform === 'win32') {
    const program = frontProgram()
    return program ? codeEditorOf(program) : undefined
  }
  if (process.platform === 'darwin') {
    const app = quick('lsappinfo', ['front']).trim()
    const bundle = app ? lsappinfoBundle(quick('lsappinfo', ['info', '-only', 'bundleid', app])) : undefined
    return bundle ? macEditorOf(bundle) : undefined
  }
  if (process.platform === 'linux') {
    const window = xpropActiveWindow(quick('xprop', ['-root', '_NET_ACTIVE_WINDOW']))
    const classes = window ? xpropClasses(quick('xprop', ['-id', window, 'WM_CLASS'])) : []
    return classes.map(linuxEditorOf).find(Boolean)
  }
  return undefined
}

type Front = () => string | undefined
let front: Front | null | undefined

/** The file of the program whose window is in front ("C:\…\Code.exe"), or undefined when that cannot be told. */
export function frontProgram(): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (front === undefined) {
    try {
      const user32 = koffi.load('user32.dll')
      const kernel32 = koffi.load('kernel32.dll')
      const foreground = user32.func('intptr_t __stdcall GetForegroundWindow()')
      const processOf = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)')
      const open = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
      const close = kernel32.func('int __stdcall CloseHandle(intptr_t handle)')
      const imageName = kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, void *name, _Inout_ uint32_t *size)')
      front = () => {
        const hwnd = foreground()
        if (!hwnd) return undefined
        const pid = [0]
        processOf(hwnd, pid)
        if (!pid[0]) return undefined
        // Enough to read a program's name, even of one that runs as administrator.
        const handle = open(0x1000, 0, pid[0])
        if (!handle) return undefined
        try {
          const name = Buffer.alloc(2048)
          const size = [1024]
          return imageName(handle, 0, name, size) ? name.toString('utf16le', 0, size[0] * 2) : undefined
        } finally {
          close(handle)
        }
      }
    } catch {
      front = null
    }
  }
  try {
    return front ? front() : undefined
  } catch {
    return undefined
  }
}
