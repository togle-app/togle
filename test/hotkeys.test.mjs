// Togle's shortcuts, which work from any app: the keys pressed in Settings written as one, and which keys can't be one
// (they'd stop a key working in every other app, or type a character on many keyboards).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { hotkeyProblem, keysPressed, sameKeys } = await import('./.build/togle.mjs')
const { HotkeyPress, virtualKey } = await import('./.build/togle.mjs')

test('dictation hotkey fires once while held, then permits the next press', async () => {
  let down = true, presses = 0
  const gate = new HotkeyPress(key => { assert.equal(key, 120); return down })
  const fire = () => gate.run('F9', () => presses++)
  fire(); fire(); fire(); assert.equal(presses, 1)
  await new Promise(resolve => setTimeout(resolve, 50)); fire(); assert.equal(presses, 1)
  down = false; await new Promise(resolve => setTimeout(resolve, 50))
  down = true; fire(); assert.equal(presses, 2)
  gate.reset(); down = false; fire(); assert.equal(presses, 3, 'A quick press already released still works')
  assert.equal(virtualKey('Ctrl+Alt+Space'), 32)
  assert.equal(virtualKey('Ctrl+F24'), 135)
  assert.equal(virtualKey('Alt+Shift+K'), 75)
  assert.equal(virtualKey('Ctrl+Alt+num5'), 101)
})

const press = (key, code, mods = '') => ({ key, code, ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s'), metaKey: mods.includes('w') })

test('hold dictation releases exactly once, including a quick tap, and reset does not insert', async () => {
  let down = true, started = 0, released = 0
  const gate = new HotkeyPress(() => down), run = () => gate.run('F9', () => started++, () => released++)
  run(); run(); assert.equal(started, 1); assert.equal(released, 0)
  down = false; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(released, 1)
  run(); assert.equal(started, 2); assert.equal(released, 2)
  down = true; run(); gate.reset(); down = false
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(released, 2)
})

test('the keys pressed, as a shortcut: modifiers first, a letter as the keyboard writes it, the rest by where it is', () => {
  assert.deepEqual(keysPressed(press('K', 'KeyK', 'cas')), { keys: 'Ctrl+Alt+Shift+K', key: 'K' })
  assert.deepEqual(keysPressed(press(' ', 'Space', 'ca')), { keys: 'Ctrl+Alt+Space', key: 'Space' })
  // A Croatian or German keyboard: the key where English has Y writes Z, and Z is what it is.
  assert.deepEqual(keysPressed(press('z', 'KeyY', 'as')), { keys: 'Alt+Shift+Z', key: 'Z' })
  // Shift turns 1 into !: the digit it's on.
  assert.deepEqual(keysPressed(press('!', 'Digit1', 'cas')), { keys: 'Ctrl+Alt+Shift+1', key: '1' })
  assert.deepEqual(keysPressed(press('F9', 'F9')), { keys: 'F9', key: 'F9' })
  assert.deepEqual(keysPressed(press('ArrowUp', 'ArrowUp', 'ca')), { keys: 'Ctrl+Alt+Up', key: 'Up' })
  assert.deepEqual(keysPressed(press('5', 'Numpad5', 'ca')), { keys: 'Ctrl+Alt+num5', key: 'num5' })
  // Only modifiers so far: no key yet.
  assert.deepEqual(keysPressed(press('Control', 'ControlLeft', 'c')), { keys: 'Ctrl', key: '' })
  assert.deepEqual(keysPressed(press('Alt', 'AltLeft', 'ca')), { keys: 'Ctrl+Alt', key: '' })
})

test('keys that would take a key from every other app, or type a character, are said to be wrong, and why', () => {
  for (const ok of ['Ctrl+Alt+Space', 'Ctrl+Alt+Enter', 'Ctrl+Alt+Shift+D', 'Alt+Shift+K', 'F9', 'Ctrl+F12', 'Ctrl+Alt+Up', 'Super+Alt+K', 'Ctrl+Shift+Space'])
    assert.equal(hotkeyProblem(ok), undefined, ok)
  assert.match(hotkeyProblem('K'), /^Add Ctrl or Alt/)
  assert.match(hotkeyProblem('Shift+K'), /^Add Ctrl or Alt/)
  assert.match(hotkeyProblem('Ctrl+Alt+K'), /AltGr/)
  assert.match(hotkeyProblem('Ctrl+Alt+2'), /AltGr/)
  assert.match(hotkeyProblem('Ctrl+K'), /Ctrl\+C copies/)
  assert.match(hotkeyProblem('Ctrl+Shift+K'), /Ctrl\+C copies/)
  assert.match(hotkeyProblem('Alt+K'), /opens menus/)
  assert.match(hotkeyProblem('Ctrl+Alt+Esc'), /^Esc closes things/)
  assert.match(hotkeyProblem('Ctrl+Alt+,'), /^That key can't be a shortcut/)
  assert.match(hotkeyProblem('Ctrl+Alt'), /^Press a key too/)
})

test('the same keys however they are written', () => {
  assert.ok(sameKeys('Ctrl+Alt+Space', 'alt+ctrl+space'))
  assert.ok(sameKeys('CommandOrControl+Shift+K', 'Ctrl+Shift+K'))
  assert.ok(!sameKeys('Ctrl+Alt+Space', 'Ctrl+Alt+Shift+Space'))
  assert.ok(!sameKeys('', ''))
})
