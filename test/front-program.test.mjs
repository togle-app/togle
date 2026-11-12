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

test('the program in front is told by its file, or not at all', () => {
  const program = T.frontProgram()
  if (process.platform !== 'win32') return assert.equal(program, undefined, 'Windows only for now')
  // Whatever is in front while the tests run: a file, or nothing when no window is in front.
  assert.ok(program === undefined || /\.exe$/i.test(program), String(program))
})
