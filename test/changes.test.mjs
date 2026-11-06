// The recorder's choice of frames, fed synthetic screens 10 looks per second: one frame per visible change,
// and none for people moving on camera.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ChangeDetector, PROBE_WIDTH: W, PROBE_HEIGHT: H } = await import('./.build/changes.mjs')

/** Shows `scene(t)` (t in seconds) for `seconds`; returns when frames were kept, and when their change began. */
function record(scene, seconds) {
  const changes = new ChangeDetector()
  const kept = []
  kept.changedAt = []
  for (let look = 0; look <= seconds * 10; look++) {
    const t = look / 10
    if (!changes.see(scene(t), 1_000_000 + look * 100)) continue
    kept.push(t)
    kept.changedAt.push((changes.changedAt - 1_000_000) / 1000)
  }
  return kept
}

const picture = (level) => new Uint8Array(W * H).fill(level)
function box(lum, x, y, w, h, level) {
  for (let row = y; row < y + h; row++) lum.fill(level, row * W + x, row * W + x + w)
}
/** Lines of "text" whose lengths depend on `page`, starting `offset` pixels up. */
function text(lum, page, offset = 0) {
  for (let line = 0; line < 30; line++) {
    const y = 20 + line * 6 - offset
    if (y >= 10 && y < H - 4) box(lum, 30, y, 100 + ((page * 37 + line * 53) % 120), 3, 60)
  }
}
/** Someone on camera: never the same picture twice. */
let seed = 1
function person(lum, x, y, w, h) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      lum[row * W + col] = 60 + (seed % 140)
    }
  }
}
const near = (kept, expected) => kept.length === expected.length && kept.every((t, i) => Math.abs(t - expected[i]) <= 0.6)

test("slides with the speaker's video beside them: a frame per slide, where its transition ended", () => {
  const slide = (n) => {
    const lum = picture(230)
    text(lum, n)
    return lum
  }
  const kept = record((t) => {
    // New slides at 10 s and 20 s, each fading in over a second.
    const n = t < 10 ? 0 : t < 20 ? 1 : 2
    const fade = Math.min(1, t - n * 10)
    const next = slide(n)
    const lum = n && fade < 1 ? slide(n - 1).map((v, i) => Math.round(v + (next[i] - v) * fade)) : next
    person(lum, 270, 0, 50, 30)
    return lum
  }, 30)
  assert.ok(near(kept, [0, 11.4, 21.4]), `kept at ${kept.join(', ')} s`)
  // Kept once the fade ended, each frame stands for the moment the slide changed: words said meanwhile are about it.
  assert.ok(near(kept.changedAt, [0, 10.1, 20.1]), `changed at ${kept.changedAt.join(', ')} s`)
})

test('beside a strip of video tiles a third of the picture high, edits on the slide are kept at once', () => {
  const kept = record((t) => {
    const lum = picture(230)
    text(lum, 2)
    if (t >= 10) box(lum, 150, 64, 80, 1, 20) // a new arrow
    if (t >= 20) box(lum, 30, 106, 125, 2, 40) // a new bullet, in the cells right above the tiles
    // Typing right above the tiles from 30 s to 35 s, five characters a second.
    const typed = Math.max(0, Math.min(25, Math.floor((t - 30) * 5)))
    for (let i = 0; i < typed; i++) box(lum, 170 + i * 6, 112, 2, 3, 30)
    for (let tile = 0; tile < 6; tile++) person(lum, tile * 53 + 2, 136, 49, 44)
    return lum
  }, 40)
  const after = (t) => kept.find((k) => k >= t) - t
  assert.ok(after(10) <= 0.6, `the arrow: kept at ${kept.join(', ')} s`)
  assert.ok(after(20) <= 0.6, `the bullet: kept at ${kept.join(', ')} s`)
  assert.ok(kept.filter((k) => k >= 30 && k <= 36).length >= 2, `the typing: kept at ${kept.join(', ')} s`)
})

test('a speaker view keeps a frame when a screen share starts, not while people move', () => {
  const kept = record((t) => {
    if (t < 20) {
      const lum = picture(100)
      person(lum, 80, 20, 160, 160)
      return lum
    }
    // The shared screen, and at 30 s a new arrow drawn on it (80 pixels).
    const lum = picture(230)
    text(lum, 4)
    if (t >= 30) box(lum, 150, 170, 80, 1, 20)
    return lum
  }, 40)
  assert.ok(near(kept, [0, 20.4, 30.4]), `kept at ${kept.join(', ')} s`)
})

test('typing keeps a frame every couple of seconds while it goes on', () => {
  const kept = record((t) => {
    const lum = picture(30)
    // Five characters a second for 10 s, from 5 s on: 6 pixels each.
    const typed = Math.max(0, Math.min(50, Math.floor((t - 5) * 5)))
    for (let i = 0; i < typed; i++) box(lum, 20 + (i % 40) * 6, 40 + Math.floor(i / 40) * 8, 2, 3, 200)
    return lum
  }, 20)
  const typing = kept.filter((t) => t > 5)
  assert.ok(typing.length >= 4, `kept at ${kept.join(', ')} s`)
  assert.ok(typing.every((t, i) => i === 0 || t - typing[i - 1] <= 2.5), `kept at ${kept.join(', ')} s`)
})

test('a long scroll is left out while it moves, and kept where it stopped', () => {
  const page = (offset) => {
    const lum = picture(240)
    text(lum, 7, offset)
    return lum
  }
  const changes = new ChangeDetector()
  const kept = []
  let last
  for (let look = 0; look <= 250; look++) {
    const t = look / 10
    // Scrolls 2 pixels a look from 10 s to 15 s.
    const lum = page(Math.min(100, Math.max(0, look - 100) * 2))
    if (changes.see(lum, 1_000_000 + look * 100)) {
      kept.push(t)
      last = lum
    }
  }
  const after = kept.filter((t) => t >= 15)
  assert.equal(after.length, 1, `kept at ${kept.join(', ')} s`)
  assert.ok(after[0] <= 18, `kept at ${kept.join(', ')} s`)
  assert.deepEqual(last, page(100), 'the frame kept is where the scroll ended')
  assert.ok(kept.filter((t) => t > 10 && t < 15).length <= 3, `kept at ${kept.join(', ')} s`)
})

test('a message in a chat beside the video counts as new content; the person moving in the tile does not', () => {
  const changes = new ChangeDetector()
  const kinds = []
  for (let look = 0; look <= 700; look++) {
    const t = look / 10
    const lum = picture(235)
    // The video tile on the left: someone on camera the whole time.
    person(lum, 20, 30, 180, 120)
    // The chat on the right: an old message, and from 60 s a pasted stack trace below it.
    box(lum, 250, 12, 60, 3, 40)
    box(lum, 250, 18, 40, 3, 40)
    if (t >= 60) for (let line = 0; line < 8; line++) box(lum, 250, 100 + line * 6, 30 + ((line * 17) % 35), 3, 40)
    if (changes.see(lum, 1_000_000 + look * 100)) kinds.push([t, changes.content])
  }
  const paste = kinds.find(([t]) => t >= 60)
  assert.ok(paste, `the paste is kept: ${JSON.stringify(kinds)}`)
  assert.equal(paste[1], true, 'and counts as content')
  assert.deepEqual(
    kinds.filter(([t]) => t > 0 && t < 60).map(([, content]) => content),
    kinds.filter(([t]) => t > 0 && t < 60).map(() => false),
    'whatever is kept for the person moving is not content'
  )
})

test('typing in a pane that scrolled a moment before is kept once it stops, not half a minute later', () => {
  /** A pane of text lines, scrolled `offset` pixels, with `typed` characters typed into it. */
  const pane = (offset, typed) => {
    const lum = picture(230)
    for (let line = 0; line < 120; line++) {
      const y = 2 + line * 6 - offset
      if (y >= 0 && y < 97) box(lum, 2, y, 20 + ((line * 53) % 75), 3, 60)
    }
    for (let i = 0; i < typed; i++) {
      const y = 150 + Math.floor(i / 8) * 8 - offset
      if (y >= 0 && y < 97) box(lum, 40 + (i % 8) * 6, y, 2, 3, 20)
    }
    return lum
  }
  // Scrolled for 5 s from 5 s (to 100 px), then 12 characters typed in it from 13 s to 15.4 s.
  const scene = (t) => pane(Math.round(Math.min(100, Math.max(0, (t - 5) * 20))), Math.max(0, Math.min(12, Math.floor((t - 13) * 5))))
  const changes = new ChangeDetector()
  const shown = []
  for (let look = 0; look <= 300; look++) {
    const t = look / 10
    const lum = scene(t)
    if (changes.see(lum, 1_000_000 + look * 100)) shown.push([t, lum[50 * W + 40] === 20])
  }
  const typed = shown.find(([, hasText]) => hasText)
  assert.ok(typed && typed[0] < 20, `kept: ${JSON.stringify(shown)}`)
})
