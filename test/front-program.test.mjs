import assert from 'node:assert/strict'
import { test } from 'node:test'
const T = await import('./.build/togle.mjs')

// The one-time offer to change keys is made only in a code editor that uses F8, F9 or F10 itself.

test('the code editors that use the debugger keys are known by their program, wherever it is installed', () => {
  for (const [program, editor] of [
    ['C:\\Users\\someone\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'VS Code'],
    ['C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe', 'VS Code'],
    ['C:\\Users\\someone\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 'Cursor'],
    ['C:\\Users\\someone\\AppData\\Local\\Programs\\Windsurf\\Windsurf.exe', 'Windsurf'],
    ['C:\\Program Files\\VSCodium\\VSCodium.exe', 'VSCodium'],
    ['C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe', 'Visual Studio'],
    ['C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.2\\bin\\idea64.exe', 'IntelliJ IDEA'],
    ['C:\\Program Files\\JetBrains\\PyCharm 2026.2\\bin\\pycharm64.exe', 'PyCharm'],
    ['C:\\Program Files\\JetBrains\\Rider\\bin\\rider64.exe', 'Rider'],
    ['C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe', 'Android Studio'],
    ['/Applications/Visual Studio Code.app/Contents/MacOS/Code', 'VS Code']
  ]) assert.equal(T.codeEditorOf(program), editor, program)
  for (const program of ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Windows\\explorer.exe', 'C:\\Program Files\\Notepad++\\notepad++.exe', 'C:\\Windows\\System32\\cmd.exe', 'WindowsTerminal.exe', 'Togle.exe', '']) {
    assert.equal(T.codeEditorOf(program), undefined, program)
  }
})

test('on a Mac the editor is told by its bundle id, and on Linux by its window class', () => {
  for (const [bundle, editor] of [
    ['com.microsoft.VSCode', 'VS Code'], ['com.microsoft.VSCodeInsiders', 'VS Code'], ['com.vscodium', 'VSCodium'], ['com.todesktop.230313mzl4w4u92', 'Cursor'],
    ['com.exafunction.windsurf', 'Windsurf'], ['com.jetbrains.intellij', 'IntelliJ IDEA'], ['com.jetbrains.intellij.ce', 'IntelliJ IDEA'], ['com.jetbrains.pycharm.ce', 'PyCharm'],
    ['com.jetbrains.WebStorm', 'WebStorm'], ['com.jetbrains.CLion', 'CLion'], ['com.google.android.studio', 'Android Studio']
  ]) assert.equal(T.macEditorOf(bundle), editor, bundle)
  for (const bundle of ['com.apple.Terminal', 'com.google.Chrome', 'com.jetbrains.toolbox', '']) assert.equal(T.macEditorOf(bundle), undefined, bundle)
  for (const [windowClass, editor] of [['code', 'VS Code'], ['Code', 'VS Code'], ['code - insiders', 'VS Code'], ['cursor', 'Cursor'], ['jetbrains-idea', 'IntelliJ IDEA'], ['jetbrains-idea-ce', 'IntelliJ IDEA'], ['jetbrains-pycharm-ce', 'PyCharm'], ['jetbrains-studio', 'Android Studio']]) {
    assert.equal(T.linuxEditorOf(windowClass), editor, windowClass)
  }
  for (const windowClass of ['gnome-terminal-server', 'firefox', 'jetbrains-toolbox', '']) assert.equal(T.linuxEditorOf(windowClass), undefined, windowClass)
  // What the system's tools print, read.
  assert.equal(T.lsappinfoBundle('"CFBundleIdentifier"="com.microsoft.VSCode"\n'), 'com.microsoft.VSCode')
  assert.equal(T.lsappinfoBundle(''), undefined)
  assert.equal(T.xpropActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007\n'), '0x3a00007')
  assert.equal(T.xpropActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n'), undefined, 'no window in front')
  assert.deepEqual(T.xpropClasses('WM_CLASS(STRING) = "code", "Code"\n'), ['code', 'Code'])
  assert.deepEqual(T.xpropClasses('WM_CLASS:  not found.\n'), [])
})

test('the program in front is told by its file, or not at all', () => {
  const program = T.frontProgram()
  if (process.platform !== 'win32') return assert.equal(program, undefined, 'Windows only for now')
  // Whatever is in front while the tests run: a file, or nothing when no window is in front.
  assert.ok(program === undefined || /\.exe$/i.test(program), String(program))
})
