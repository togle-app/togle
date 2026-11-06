import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const home = workDir('window-place')
const T = await import('./.build/togle.mjs')
const electron = globalThis.__togleTestElectron
const area = { x: 0, y: 0, width: 1920, height: 1040 }
electron.screen.getAllDisplays = () => [{ workArea: area }]
const file = path.join(home, 'window.json')
const min = { width: 400, height: 420 }
const save = value => fs.writeFileSync(file, JSON.stringify(value))

test('the old compact workspace opens wide enough for the agent sidebar on its current display', () => {
  save({ x: 1450, y: 20, width: 440, height: 760 })
  const bounds = T.lastPlace(min)
  assert.equal(bounds.width, 960)
  assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.width)
  assert.equal(bounds.y, 20)
})

test('a compact size explicitly saved with the sidebar is respected on the next launch', () => {
  save({ x: 1000, y: 30, width: 440, height: 760, layout: 'agent-sidebar' })
  assert.deepEqual(T.lastPlace(min), { x: 1000, y: 30, width: 440, height: 760 })
})

test('an already wide window is not moved or resized during migration', () => {
  save({ x: 100, y: 40, width: 1200, height: 850 })
  assert.deepEqual(T.lastPlace(min), { x: 100, y: 40, width: 1200, height: 850 })
})

test('a disconnected monitor cannot leave the workspace off screen', () => {
  save({ x: 2500, y: 20, width: 440, height: 760 })
  assert.equal(T.lastPlace(min), undefined)
})

test('saving window position records the sidebar layout without losing a manual size', () => {
  const window = new EventEmitter()
  Object.assign(window, { isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false, isFullScreen: () => false, getBounds: () => ({ x: 100, y: 40, width: 460, height: 700 }) })
  T.keepPlace(window)
  window.emit('close')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).layout, 'agent-sidebar')
  assert.equal(T.lastPlace(min).width, 460)
})
