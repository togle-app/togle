// How dictated words get into another app on each system, as the design says: hold F9 and they go in on Windows, a Mac
// and Linux on X11; on a Wayland desktop F9 starts and stops and the words are copied. The Mac and X11 paths themselves
// need those systems; here are the rules around them.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  typingWay, holdsByDefault, onWayland, macKeyCode, x11Keysym, isMacTerminal, isLinuxTerminal, oneLine, shellQuoted,
  DesktopTyping, HotkeyPress, Dictation
} = await import('./.build/togle.mjs')

test('each system types its own way, and a Wayland desktop only copies', () => {
  assert.equal(typingWay('win32', {}), 'windows')
  assert.equal(typingWay('darwin', {}), 'mac')
  assert.equal(typingWay('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), 'x11')
  assert.equal(typingWay('linux', { DISPLAY: ':0' }), 'x11', 'an X11 desktop that does not name its session')
  assert.equal(typingWay('linux', { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), 'copy', 'Wayland, even with XWayland')
  assert.equal(typingWay('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), 'copy')
  assert.equal(typingWay('linux', {}), 'copy', 'no display at all: a server or a console')
  assert.equal(onWayland({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), false, 'the session says X11')
  assert.equal(holdsByDefault('win32', {}), true)
  assert.equal(holdsByDefault('darwin', {}), true)
  assert.equal(holdsByDefault('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), true)
  assert.equal(holdsByDefault('linux', { XDG_SESSION_TYPE: 'wayland' }), false, 'F9 starts and stops there')
})

test('the hold key is read by each system its own code', () => {
  assert.equal(macKeyCode('F9'), 0x65)
  assert.equal(macKeyCode('F8'), 0x64)
  assert.equal(macKeyCode('F10'), 0x6d)
  assert.equal(macKeyCode('Ctrl+Alt+Space'), 0x31)
  assert.equal(macKeyCode('Command+K'), 0x28)
  assert.equal(macKeyCode('num5'), 0x57)
  assert.equal(macKeyCode('F24'), undefined, 'a Mac keyboard has no F24')
  assert.equal(x11Keysym('F9'), 0xffc6)
  assert.equal(x11Keysym('F24'), 0xffd5)
  assert.equal(x11Keysym('Ctrl+A'), 0x61)
  assert.equal(x11Keysym('Alt+7'), 0x37)
  assert.equal(x11Keysym('num0'), 0xffb0)
  assert.equal(x11Keysym('Space'), 0x20)
  assert.equal(x11Keysym('PageDown'), 0xff56)
  // The press gate asks for the key by the code its system reads.
  const asked = []
  const gate = new HotkeyPress((code) => { asked.push(code); return false }, macKeyCode)
  gate.run('F9', () => {})
  assert.deepEqual(asked, [0x65])
})

test('terminals are told apart, and words for them go in as one line', () => {
  assert.equal(isMacTerminal('com.apple.Terminal'), true)
  assert.equal(isMacTerminal('com.googlecode.iterm2'), true)
  assert.equal(isMacTerminal('com.mitchellh.ghostty'), true)
  assert.equal(isMacTerminal('com.microsoft.VSCode'), false)
  assert.equal(isLinuxTerminal(['gnome-terminal-server', 'Gnome-terminal']), true)
  assert.equal(isLinuxTerminal(['konsole', 'konsole']), true)
  assert.equal(isLinuxTerminal(['kitty', 'kitty']), true)
  assert.equal(isLinuxTerminal(['code', 'Code']), false)
  assert.equal(oneLine('cd ~/work\r\n  run the tests\tnow\n'), 'cd ~/work run the tests now')
  assert.equal(shellQuoted("/home/ana/it's here.png"), "'/home/ana/it'\\''s here.png'")
})

test('on a Wayland desktop the words are copied, and the bar says why and how to paste', async () => {
  const target = await new DesktopTyping('copy').capture()
  assert.equal(target.copy, true)
  assert.equal(target.token, undefined, 'nothing is typed')
  assert.match(target.copyReason, /can't type into other apps/)
  const copied = []
  const job = new Dictation({
    target: { capture: async () => target, insert: async () => { throw new Error('nothing is typed') } },
    speech: () => ({ ready: async () => {}, transcribe: async () => 'send it to Marta by Friday', polish: async (text) => text + '.' }),
    changed: () => {}, inCall: () => false, copy: (text) => copied.push(text)
  })
  await job.start(false)
  const id = job.status().id
  job.push(id, new Float32Array(16000).fill(1)); job.stop(); await job.finish(id)
  const status = job.status()
  job.dispose()
  assert.deepEqual(copied, ['send it to Marta by Friday.'])
  assert.deepEqual([status.phase, status.outcome], ['done', 'copied'])
  assert.match(status.message, /^Copied: on this desktop Togle can't type into other apps\. Press (Ctrl\+V|⌘V) to paste\.$/)
})

test('a hold that lets go at once keeps dictation on until the next press', async () => {
  const job = new Dictation({
    target: { capture: async () => ({ token: 't', label: 'Notes' }), insert: async () => ({ inserted: true }) },
    speech: () => ({ ready: async () => {}, transcribe: async () => 'words', polish: async (text) => text }),
    changed: () => {}, inCall: () => false
  })
  await job.start(true)
  const id = job.status().id
  assert.equal(job.status().hold, true)
  job.keepOn('another dictation')
  assert.equal(job.status().hold, true, 'only the dictation that was held')
  job.keepOn(id)
  assert.deepEqual([job.status().phase, job.status().hold], ['recording', false], 'still on, and the bar now says press, not release')
  job.dispose()
})
