const { EventEmitter } = require('node:events')

// Replace only the Windows shell. The app still makes its real toasts, handles activations and opens its real renderer.
exports.windowsShell = (electron) => {
  const posted = [], dialogs = []
  class Notification extends EventEmitter {
    static isSupported() { return true }
    static handleActivation(callback) { Notification.activate = callback }
    constructor(options) { super(); this.options = options }
    show() { posted.push(this); this.emit('show', {}) }
    close() { this.closed = true; this.emit('close', { reason: 'applicationHidden' }) }
    click() { Notification.activate({ type: 'action', arguments: /launch="([^"]+)"/.exec(this.options.toastXml)[1].replaceAll('&amp;', '&') }) }
  }
  const dialog = { ...electron.dialog, showMessageBox: (...args) => new Promise(resolve => dialogs.push({ options: args.at(-1), answer: response => resolve({ response }) })) }
  return { posted, dialogs, api: { Notification, dialog } }
}
