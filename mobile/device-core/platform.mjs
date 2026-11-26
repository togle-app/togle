// The listener contract used by Reach and its node-ws transport, backed by React Native's WebSocket.
import { Bytes } from './bytes.mjs'
export class EventEmitter {
  #listeners = new Map()
  on(name, callback) {
    if (!this.#listeners.has(name)) this.#listeners.set(name, new Set())
    this.#listeners.get(name).add(callback)
    return this
  }
  emit(name, ...args) { for (const callback of this.#listeners.get(name) || []) callback(...args) }
  removeAllListeners() { this.#listeners.clear() }
}

export class Socket extends EventEmitter {
  static OPEN = 1
  constructor(address, limits) {
    super()
    // Fixed native application configuration. Remote peers and displayed text never set an address.
    if (address !== __TOGLE_COURIER__) throw new Error('Unknown Togle relay.')
    this.socket = new globalThis.WebSocket(address)
    const handshake = setTimeout(() => this.close(), limits.handshakeTimeout)
    this.socket.onopen = () => { clearTimeout(handshake); this.emit('open') }
    this.socket.onmessage = ({ data }) => {
      if (typeof data !== 'string' || data.length > limits.maxPayload || Bytes.from(data).length > limits.maxPayload) {
        this.socket.close(4009, 'Invalid frame')
        return
      }
      this.emit('message', data, false)
    }
    this.socket.onerror = () => this.emit('error')
    this.socket.onclose = () => { clearTimeout(handshake); this.emit('close') }
  }
  get readyState() { return this.socket.readyState }
  send(text) { this.socket.send(text) }
  close() { this.socket.close() }
}
export default Socket
