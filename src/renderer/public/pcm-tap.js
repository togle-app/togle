// AudioWorklet: turns the device-rate stream (usually 48 kHz) into 16 kHz mono for Whisper and posts it
// in 512-sample (32 ms) frames. The context runs at the device's native rate: a 16 kHz AudioContext on
// some Windows audio drivers renders far slower than real time, which stalls the whole pipeline.
const TARGET_RATE = 16000
const FRAME = 512
// Anti-aliasing low-pass before dropping to 16 kHz: passes speech up to ~7 kHz and removes what's above
// 8 kHz, which would otherwise fold back into the speech band as hiss and smeared "s" sounds.
const CUTOFF_HZ = 7000
const TAPS = 96

/** Windowed-sinc (Blackman) low-pass FIR taps for a sample rate, normalized to unity gain. */
function lowPass(rate) {
  const fc = CUTOFF_HZ / rate
  const taps = new Float32Array(TAPS)
  const mid = (TAPS - 1) / 2
  let sum = 0
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1))
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < TAPS; i++) taps[i] /= sum
  return taps
}

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET_RATE
    this.taps = lowPass(sampleRate)
    // The last TAPS input samples, twice over, so a window is always one contiguous slice.
    this.history = new Float32Array(TAPS * 2)
    this.head = 0
    // Read position in filtered input samples since the start (fractional); counts input samples seen.
    this.pos = TAPS
    this.seen = 0
    this.lastOut = 0
    this.prevOut = 0
    this.frame = new Float32Array(FRAME)
    this.filled = 0
    this.stopped = false
    this.port.onmessage = event => {
      if (event.data?.type !== 'flush' || this.stopped) return
      this.stopped = true
      if (this.filled) {
        const tail = this.frame.slice(0, this.filled)
        this.port.postMessage(tail, [tail.buffer]); this.filled = 0
      }
      this.port.postMessage({ type: 'flushed' })
    }
  }

  push(sample) {
    this.frame[this.filled++] = sample
    if (this.filled === FRAME) {
      this.port.postMessage(this.frame, [this.frame.buffer])
      this.frame = new Float32Array(FRAME)
      this.filled = 0
    }
  }

  /** The filtered value at the newest input sample. */
  filter() {
    const h = this.history
    const t = this.taps
    const start = this.head
    let acc = 0
    for (let k = 0; k < TAPS; k++) acc += h[start + k] * t[k]
    return acc
  }

  process(inputs) {
    if (this.stopped) return false
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      // Ring buffer mirrored at +TAPS so history[head .. head+TAPS) holds the last TAPS samples in order.
      this.history[this.head] = input[i]
      this.history[this.head + TAPS] = input[i]
      this.head = (this.head + 1) % TAPS
      this.seen++
      this.prevOut = this.lastOut
      this.lastOut = this.filter()
      // Emit every output sample whose position falls between the previous and this filtered sample.
      while (this.pos <= this.seen) {
        const frac = this.pos - (this.seen - 1)
        this.push(this.prevOut + (this.lastOut - this.prevOut) * frac)
        this.pos += this.ratio
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
