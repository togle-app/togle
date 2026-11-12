// Which program is in front, and whether it is a code editor that uses F8, F9 or F10 itself (for its debugger): the first
// time one of Togle's keys is pressed there, Togle offers once to change its keys. Windows only for now; elsewhere
// nothing is known to be in front, and no offer is made.
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
