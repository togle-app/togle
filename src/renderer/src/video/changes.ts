// The recorder looks at the screen 10× per second through a small grayscale probe of it, and keeps a frame
// when what's shown changed. No DOM in here, so the tests can feed it pictures.

// Fine enough that a thin line (a new arrow, a box outline) covers whole probe pixels.
export const PROBE_WIDTH = 320
export const PROBE_HEIGHT = 180
// A probe pixel counts as changed past this luminance delta; a frame is kept when more than
// CHANGED_FRACTION of them changed since the last kept frame. Comparing against the last kept frame
// (not the previous look) lets slow changes add up, so typing or drawing still gets saved as it grows.
// 0.1% is ~58 probe pixels: one new box or labeled arrow counts, a moving mouse pointer (~12) doesn't.
const PIXEL_DELTA = 20
const CHANGED_FRACTION = 0.001
// The frame is kept once the picture holds still this long, so a slide transition or a scroll gives one
// frame of where it ended instead of several of the way there; if it keeps changing (typing), every so often.
// Never more than 4 frames a second.
const SETTLE_MS = 400
const MAX_WAIT_MS = 2000
const MIN_GAP_MS = 250
// Places that never keep still (people on camera, a playing video) are left out of the count, or a video
// call would keep a frame every second. The picture is watched in cells, every half second: a cell is in
// motion when its pixels change step after step, while an edit or a new slide changes them once and stays.
const CELL = 20
const STEP_MS = 500
const MOVING_PIXELS = 4
// Two steps of motion make a cell moving, and about half a minute without any lets it count again.
const RISE = 0.3
const FALL = 1 / 60
const MOVING = 0.5
// People move around the face that gives them away too (shoulders, hands), now and then: a cell next to one
// in motion is left out as well when it has moved back and forth lately. Typing or a new bullet beside a strip
// of video tiles changes a cell once and stays, so it still counts. On recorded calls this kept 2.5-23× fewer
// frames than counting everything (a 12-minute speaker view: 239 instead of 594; 44 minutes of slides beside
// the presenter's video: 133 instead of 3,089), without missing a slide, a scrolled document, or typing in it.
const RING_MOTION = 0.1
// A cell in motion still counts when it has kept still for 2 s on something new (most of it differs from the
// kept frame): a scroll that ended, a video stopped on a slide.
const SETTLED_STEPS = 4
const SETTLED_FRACTION = 0.3
// So much changed at once that it's a new scene (a screen share started, the layout changed): the motion
// learned where it changed doesn't apply any more.
const SCENE_FRACTION = 0.25
// Looks kept to tell whether the picture holds still (about 5 at 10 a second); a bound in case the clock jumps.
const RECENT_LOOKS = 20

/**
 * Decides which looks at a recorded screen are kept as frames: one per visible change, not per motion. Times are
 * from a clock that only goes forward (performance.now()).
 */
export class ChangeDetector {
  private readonly cols = Math.ceil(PROBE_WIDTH / CELL)
  private readonly rows = Math.ceil(PROBE_HEIGHT / CELL)
  private readonly cells = this.cols * this.rows
  /** The cell of each probe pixel, and how many pixels each cell has. */
  private readonly cellOf = new Uint16Array(PROBE_WIDTH * PROBE_HEIGHT)
  private readonly cellSize = new Uint16Array(this.cells)
  private kept: Uint8Array | null = null
  private lastKeptAt = 0
  /** Since when enough has changed to keep a frame, waiting for the picture to settle (0: nothing waiting). */
  private pendingSince = 0
  /** Recent looks, oldest first: the first is from SETTLE_MS ago or more. */
  private recent: { lum: Uint8Array; at: number }[] = []
  /** The pictures at the last two steps. */
  private older: Uint8Array | null = null
  private previous: Uint8Array | null = null
  private lastStepAt = 0
  /** Per cell: how much it has been in motion lately (0-1), and for how many steps it has kept still. */
  private readonly motion = new Float32Array(this.cells)
  private readonly still = new Uint16Array(this.cells)
  /** Cells left out of the count: in motion, or restless next to one that is. */
  private readonly masked = new Uint8Array(this.cells)
  /** Cells at rest when the last frame was kept: what that frame shows of them is where they stopped. */
  private readonly restAtKeep = new Uint8Array(this.cells)
  /** When the change in the last kept frame began: the moment the frame stands for. */
  changedAt = 0
  /**
   * The last kept frame changed where the picture otherwise keeps still (a chat message, a new bullet, typing), not
   * only where people move, nor all over (a new scene): a picture of the same people doesn't cover it.
   */
  content = false

  constructor() {
    for (let i = 0; i < this.cellOf.length; i++) {
      const c = Math.floor(Math.floor(i / PROBE_WIDTH) / CELL) * this.cols + Math.floor((i % PROBE_WIDTH) / CELL)
      this.cellOf[i] = c
      this.cellSize[c]++
    }
  }

  /** Takes a look at the screen (luminance, PROBE_WIDTH × PROBE_HEIGHT, not changed afterwards): keep it? */
  see(lum: Uint8Array, now: number): boolean {
    if (now - this.lastStepAt >= STEP_MS) this.step(lum, now)
    this.recent.push({ lum, at: now })
    while (this.recent.length > RECENT_LOOKS || (this.recent.length > 2 && now - this.recent[1].at >= SETTLE_MS)) this.recent.shift()
    if (!this.kept) {
      this.content = false
      return this.keep(lum, now, now)
    }
    if (now - this.lastKeptAt < MIN_GAP_MS) return false
    const diff = this.difference(lum, this.kept)
    if (!this.changed(diff)) {
      this.pendingSince = 0
      return false
    }
    this.pendingSince ||= now
    const before = this.recent[0]
    const settled = now - before.at >= SETTLE_MS && !this.changed(this.difference(lum, before.lum))
    if (!settled && now - this.pendingSince < MAX_WAIT_MS) return false
    // Before the motion a new scene forgets: what's in motion right now decides what's away from it.
    this.content = this.changedAwayFromMotion(diff)
    this.forgetMotion(diff)
    return this.keep(lum, now, this.pendingSince)
  }

  reset(): void {
    this.kept = this.older = this.previous = null
    this.lastKeptAt = this.pendingSince = this.lastStepAt = this.changedAt = 0
    this.content = false
    this.recent = []
    this.motion.fill(0)
    this.still.fill(0)
    this.masked.fill(0)
  }

  private keep(lum: Uint8Array, now: number, changedAt: number): true {
    for (let c = 0; c < this.cells; c++) this.restAtKeep[c] = this.still[c] >= SETTLED_STEPS ? 1 : 0
    this.kept = lum
    this.lastKeptAt = now
    this.changedAt = changedAt
    this.pendingSince = 0
    return true
  }

  /** How many pixels of each cell changed between two pictures. */
  private difference(a: Uint8Array, b: Uint8Array): Uint16Array {
    const diff = new Uint16Array(this.cells)
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_DELTA) diff[this.cellOf[i]]++
    return diff
  }

  /** Whether enough changed, leaving out the places in motion. */
  private changed(diff: Uint16Array): boolean {
    let count = 0
    for (let c = 0; c < this.cells; c++) {
      // At rest again on something else: most of it changed (a scroll ended, a video stopped on a slide), or it was at
      // rest in the kept frame too, so even a little is an edit, not motion (typing in a pane that scrolled before).
      const settled =
        this.still[c] >= SETTLED_STEPS && (diff[c] >= this.cellSize[c] * SETTLED_FRACTION || (this.restAtKeep[c] === 1 && diff[c] >= MOVING_PIXELS))
      if (!this.masked[c] || settled) count += diff[c]
    }
    return count > this.cellOf.length * CHANGED_FRACTION
  }

  /**
   * Whether this change is new content in one place: enough changed away from anything in motion (not in a cell left
   * out, nor next to one: people moving into a part of the picture they hadn't been in change those), but not so
   * much of it that it's a new scene. A chat panel beside a video tile is away from the person in it.
   */
  private changedAwayFromMotion(diff: Uint16Array): boolean {
    let count = 0
    let big = 0
    for (let c = 0; c < this.cells; c++) {
      if (!diff[c] || this.masked[c]) continue
      const x = c % this.cols
      const y = Math.floor(c / this.cols)
      let near = false
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1 && !near; dx++) {
          const nx = x + dx
          const ny = y + dy
          near = nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && this.masked[ny * this.cols + nx] === 1
        }
      }
      if (near) continue
      count += diff[c]
      if (diff[c] >= this.cellSize[c] * SETTLED_FRACTION) big++
    }
    return count > this.cellOf.length * CHANGED_FRACTION && big < this.cells * SCENE_FRACTION
  }

  /** A new scene (whether it was one): the cells it changed start over, so a slide shown where a video was counts at once. */
  private forgetMotion(diff: Uint16Array): boolean {
    const big = (c: number): boolean => diff[c] >= this.cellSize[c] * SETTLED_FRACTION
    let changed = 0
    for (let c = 0; c < this.cells; c++) if (big(c)) changed++
    if (changed < this.cells * SCENE_FRACTION) return false
    for (let c = 0; c < this.cells; c++) if (big(c)) this.motion[c] = 0
    this.updateMask()
    return true
  }

  /** Every half second: which cells keep changing (in motion), and which kept still. */
  private step(lum: Uint8Array, now: number): void {
    const { older, previous } = this
    if (previous) {
      const moved = new Uint16Array(this.cells)
      const again = new Uint16Array(this.cells)
      for (let i = 0; i < lum.length; i++) {
        if (Math.abs(lum[i] - previous[i]) <= PIXEL_DELTA) continue
        const c = this.cellOf[i]
        moved[c]++
        if (older && Math.abs(previous[i] - older[i]) > PIXEL_DELTA) again[c]++
      }
      for (let c = 0; c < this.cells; c++) {
        this.still[c] = moved[c] < MOVING_PIXELS ? Math.min(this.still[c] + 1, 0xffff) : 0
        this.motion[c] += again[c] >= MOVING_PIXELS ? (1 - this.motion[c]) * RISE : -this.motion[c] * FALL
      }
      this.updateMask()
    }
    this.older = previous
    this.previous = lum
    this.lastStepAt = now
  }

  private updateMask(): void {
    for (let c = 0; c < this.cells; c++) {
      let masked = this.motion[c] >= MOVING
      if (!masked && this.motion[c] >= RING_MOTION) {
        const x = c % this.cols
        const y = Math.floor(c / this.cols)
        for (let dy = -1; dy <= 1 && !masked; dy++) {
          for (let dx = -1; dx <= 1 && !masked; dx++) {
            const nx = x + dx
            const ny = y + dy
            masked = nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && this.motion[ny * this.cols + nx] >= MOVING
          }
        }
      }
      this.masked[c] = masked ? 1 : 0
    }
  }
}
