import { Reach } from './reach'

export function createPhoneClient({ relay, name, email, accessToken, store, onChange }) {
  const phone = new Reach({
    kind: 'phone', courier: relay, name: () => name, store,
    account: { who: () => ({ email }), token: accessToken }
  })
  let closed = false
  const active = new Set()
  const answered = new Set()
  const chatPending = new Set()
  const publish = () => {
    if (closed) return
    const state = phone.state()
    const reports = new Map(phone.remoteTasks().map(device => [device.device, device]))
    onChange({
      standing: state.standing, link: state.link, connection: state.connection,
      code: state.code, invitation: state.invitation, problem: state.problem,
      devices: state.standing === 'member' ? state.devices.filter(device => !device.me && device.role !== 'phone').map(device => {
        const report = reports.get(device.device)
        const online = state.link === 'member' && device.online
        const canAct = online && (report?.canAct ?? Boolean(report?.tasks.length))
        const phoneReports = online && state.connection === 'on' && report?.phoneReports === true
        return { ...device, online, canAct, phoneReports, tasks: online ? report?.tasks ?? [] : [] }
      }) : []
    })
  }
  phone.on('changed', publish)
  const ready = phone.start()

  return {
    ready,
    async pair() { await ready; if (!closed) await phone.showCode() },
    async joinInvitation(invitation) {
      await ready
      if (closed) throw new Error('The device connection is closed.')
      await phone.joinInvitation(invitation)
    },
    cancelPair() { if (!closed) phone.cancelCode() },
    async readReport(device, query) {
      await ready
      if (closed) throw new Error('The device connection is closed.')
      return phone.readPhoneReport(device, query)
    },
    async chat(device, key, action) {
      await ready
      const state = phone.state()
      const host = phone.remoteTasks().find(entry => entry.device === device && entry.role === 'computer' && entry.online)
      const task = host?.tasks.find(item => item.key === key && item.mine)
      if (closed || state.standing !== 'member' || state.link !== 'member' || state.connection !== 'on' ||
          host?.canAct !== true || task?.canSend !== true || (action.what === 'stop' && task.canStop !== true)) {
        throw new Error('Continue this conversation on its computer.')
      }
      const pending = JSON.stringify([device, key])
      if (chatPending.has(pending)) throw new Error('A chat action is already being sent.')
      chatPending.add(pending)
      try {
        const delivery = await phone.act(device, { ...action, task: key })
        if (action.what === 'send-message' && delivery !== 'sent' && delivery !== 'queued') throw new Error('Check the conversation for your message.')
        return delivery
      } finally { chatPending.delete(pending) }
    },
    async answer(deviceId, taskId, requestId, choice) {
      await ready
      const state = phone.state()
      const host = phone.remoteTasks().find(entry => entry.device === deviceId && entry.online)
      const request = host?.tasks.find(task => task.key === taskId && task.mine)?.pending
        .find(item => item.id === requestId && item.kind === 'question')
      const id = JSON.stringify([deviceId, taskId, requestId])
      if (closed || state.standing !== 'member' || state.link !== 'member' || state.connection !== 'on' || host?.canAct === false ||
          !Number.isSafeInteger(choice) || choice < 0 || choice >= (request?.choices?.length ?? 0) || answered.has(id)) {
        throw new Error('This question is no longer available.')
      }
      if (active.has(id)) throw new Error('Your answer is already being sent.')
      active.add(id)
      try {
        await phone.act(deviceId, { what: 'reply-choice', task: taskId, request: requestId, choice })
        answered.add(id)
        if (answered.size > 80) answered.delete(answered.values().next().value)
      } finally { active.delete(id) }
    },
    close() {
      closed = true
      // The keys and signed device book can finish loading while the user signs out.
      phone.stop()
      void ready.then(() => phone.stop(), () => phone.stop())
    }
  }
}
