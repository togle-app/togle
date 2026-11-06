// Picking a screen to take a picture of, when there are several.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

workDir('screen')
const { captureFrame, listScreens } = await import('./.build/togle.mjs')

const display = (id, x, y, width, height) => ({ id, bounds: { x, y, width, height } })
const picture = (url) => ({ isEmpty: () => !url, toDataURL: () => url })
const togle = { isDestroyed: () => false, getBounds: () => ({ x: 2000, y: 100, width: 440, height: 760 }) }

test('the screens come left to right, named as the recorder names them, with the main one and Togle’s marked', async () => {
  const main = display(11, 0, 0, 1920, 1080)
  const left = display(22, -1707, 0, 1707, 1067)
  const portrait = display(33, 1920, -300, 1080, 1920)
  Object.assign(electron.screen, {
    // In Windows' order, which isn't where they stand.
    getAllDisplays: () => [main, left, portrait],
    getPrimaryDisplay: () => main,
    getDisplayMatching: (bounds) => (bounds.x >= 1920 ? portrait : main)
  })
  const asked = []
  electron.desktopCapturer.getSources = async (options) => {
    asked.push(options)
    return [
      { display_id: '11', name: 'Screen 1', thumbnail: picture('data:image/png;base64,one') },
      { display_id: '22', name: 'Screen 2', thumbnail: picture('data:image/png;base64,two') },
      { display_id: '33', name: 'Screen 3', thumbnail: picture('') }
    ]
  }
  assert.deepEqual(await listScreens(togle), [
    { id: 22, name: 'Screen 2', primary: false, togle: false, thumbUrl: 'data:image/png;base64,two' },
    { id: 11, name: 'Screen 1', primary: true, togle: false, thumbUrl: 'data:image/png;base64,one' },
    { id: 33, name: 'Screen 3', primary: false, togle: true, thumbUrl: undefined }
  ])
  assert.deepEqual(asked, [{ types: ['screen'], thumbnailSize: { width: 320, height: 180 } }], 'small pictures, of screens only')
})

test('with one screen there is nothing to pick, so no picture is taken', async () => {
  const only = display(11, 0, 0, 2560, 1440)
  Object.assign(electron.screen, { getAllDisplays: () => [only], getPrimaryDisplay: () => only, getDisplayMatching: () => only })
  electron.desktopCapturer.getSources = async () => assert.fail('nothing to pick from')
  assert.deepEqual(await listScreens(togle), [{ id: 11, name: 'Screen 1', primary: true, togle: true, thumbUrl: undefined }])
})

/** A captured picture of the given size, as desktopCapturer hands it over. */
const shot = (name, width, height) => ({
  name,
  isEmpty: () => false,
  getSize: () => ({ width, height }),
  toDataURL: () => `data:${name}`,
  toJPEG: () => Buffer.from(name),
  resize: () => ({ toJPEG: () => Buffer.from(`${name}-thumb`) })
})

test("a snapshot is asked for at the screen's own pixels, also at 150%, so it isn't resampled", async () => {
  // A 2560×1440 screen at 150% is 1707×960 in scaled units, 2560.5 pixels wide by the numbers; converting them
  // as Electron does rounds up to 2561.
  const scaled = { id: 44, bounds: { x: 1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }
  const main = { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  Object.assign(electron.screen, {
    getAllDisplays: () => [scaled, main],
    getPrimaryDisplay: () => main,
    getDisplayMatching: () => main,
    dipToScreenRect: (_win, r) => ({ ...r, width: Math.ceil(r.width * 1.5), height: Math.ceil(r.height * 1.5) })
  })
  const asked = []
  electron.desktopCapturer.getSources = async ({ thumbnailSize }) => {
    asked.push(thumbnailSize)
    return [
      { display_id: '11', name: 'Screen 1', thumbnail: shot('main', 1920, 1080) },
      { display_id: '44', name: 'Screen 2', thumbnail: shot('scaled', thumbnailSize.width, thumbnailSize.height) }
    ]
  }
  const { image } = await captureFrame(togle, true, 44)
  assert.equal(String(image), 'scaled')
  assert.deepEqual(asked, [{ width: 2560, height: 1440 }])
})

test('without screen ids from the system, a screen is told apart by its shape, or not taken at all', async () => {
  const wide = { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  const tall = { id: 22, bounds: { x: 1920, y: 0, width: 1920, height: 1200 }, scaleFactor: 1 }
  Object.assign(electron.screen, { getAllDisplays: () => [tall, wide], getPrimaryDisplay: () => wide, getDisplayMatching: () => wide })
  // As on a remote desktop: no ids, and not in the displays' order.
  electron.desktopCapturer.getSources = async ({ thumbnailSize }) => {
    const fit = (w, h) => Math.min(thumbnailSize.width / w, thumbnailSize.height / h)
    return [
      { display_id: '', name: 'Screen 1', thumbnail: shot('wide', Math.round(1920 * fit(1920, 1080)), Math.round(1080 * fit(1920, 1080))) },
      { display_id: '', name: 'Screen 2', thumbnail: shot('tall', Math.round(1920 * fit(1920, 1200)), Math.round(1200 * fit(1920, 1200))) }
    ]
  }
  assert.equal(String((await captureFrame(togle, true, 22)).image), 'tall')
  assert.deepEqual(
    (await listScreens(togle)).map((s) => s.thumbUrl),
    ['data:wide', 'data:tall']
  )
  // Two screens of the same shape can't be told apart: better no picture than one of the wrong screen.
  const twin = { id: 33, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  Object.assign(electron.screen, { getAllDisplays: () => [twin, wide] })
  electron.desktopCapturer.getSources = async () => [
    { display_id: '', name: 'Screen 1', thumbnail: shot('one', 320, 180) },
    { display_id: '', name: 'Screen 2', thumbnail: shot('two', 320, 180) }
  ]
  await assert.rejects(captureFrame(togle, true, 33), /tell your screens apart/)
})

test("one screen is taken whatever id the system gave it, as it can't be any other", async () => {
  // As after a display driver update: the capture source's id no longer matches the display's.
  const only = { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  Object.assign(electron.screen, { getAllDisplays: () => [only], getPrimaryDisplay: () => only, getDisplayMatching: () => only })
  electron.desktopCapturer.getSources = async () => [{ display_id: '2779098405', name: 'Screen 1', thumbnail: shot('only', 1920, 1080) }]
  assert.equal(String((await captureFrame(togle, true, 11)).image), 'only')
})
