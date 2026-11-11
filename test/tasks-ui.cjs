// Exercises the Tasks screen in the production renderer with a fake IPC API: the list, an answer, a refusal, Stop and
// its second press, a reply, a new task, continuing and taking over. No agent, account or network is used.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
app.disableHardwareAcceleration()

const project = path.resolve(__dirname, '..')
const artifacts = path.join(__dirname, '.work', 'tasks-ui')
const data = path.join(artifacts, 'data-' + process.pid)
fs.mkdirSync(data, { recursive: true })
app.setPath('userData', data)
process.env.TOGLE_TEST_USER_DATA = data
app.on('window-all-closed', () => {})
let checkpoint = 'startup'
const timeout = setTimeout(() => { console.error('Tasks UI checks timed out at ' + checkpoint); app.exit(1) }, 120000)

async function open(T, agent, width) {
  checkpoint = 'opening at ' + width + 'px'
  const settings = structuredClone(T.getSettings())
  settings.provider = 'claude'
  settings.claude.auth = 'subscription'
  settings.dictation.accountId = 'claude-default'
  settings.transcription.language = 'en'
  settings.activeAgentId = agent.id
  settings.transcription.me = settings.transcription.them = 'local'
  const names = [...fs.readFileSync(path.join(project, 'src/shared/api.ts'), 'utf8').matchAll(/^  (\w+)\(/gm)].map(m => m[1])
  const fixture = JSON.stringify({ settings, names, agents: [agent], scenario: 'tasks', readyAudio: true, templates: T.AGENT_TEMPLATES })
  const preload = path.join(artifacts, 'preload-' + width + '.cjs')
  fs.writeFileSync(preload, 'const fixture=' + fixture + '\nrequire(' + JSON.stringify(path.join(__dirname, 'ui-fixture.cjs')) + ')(fixture)')
  const errors = []
  const window = new BrowserWindow({ show: false, width, height: 850, webPreferences: { preload, sandbox: false, backgroundThrottling: false, offscreen: true } })
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const evaluate = async code => {
    checkpoint = code.slice(0, 160)
    try { return await window.webContents.executeJavaScript(code) } catch (error) { throw new Error(error.message + '\nWhile running: ' + code + '\n' + errors.join('\n')) }
  }
  const paint = async () => {
    await evaluate('new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}))})')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  const wait = async code => {
    for (let n = 0; n < 100; n++) {
      if (await evaluate(code)) return paint()
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    const detail = await evaluate("({text:document.body.innerText.slice(0,1500),calls:window.togleUITest?.calls().slice(-8)})").catch(error => ({ error: error.message }))
    fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify({ condition: code, errors, detail }, null, 2))
    try { fs.writeFileSync(path.join(artifacts, 'failure.png'), (await window.webContents.capturePage()).toPNG()) } catch {}
    throw new Error('UI did not reach: ' + code + '\n' + JSON.stringify({ errors, detail }, null, 2))
  }
  const click = async (selector, label) => {
    await evaluate("(()=>{const button=[...document.querySelectorAll(" + JSON.stringify(selector) + ")].find(e=>e.getClientRects().length&&(e.textContent.trim()===" + JSON.stringify(label) + "||e.getAttribute('aria-label')===" + JSON.stringify(label) + "));if(!button)throw new Error('Missing button: '+" + JSON.stringify(label) + ");button.click()})()")
    await paint()
  }
  const fill = async (selector, value) => {
    await evaluate("(()=>{const el=document.querySelector(" + JSON.stringify(selector) + ");const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el," + JSON.stringify(value) + ");el.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await paint()
  }
  const capture = async name => {
    await paint()
    fs.writeFileSync(path.join(artifacts, name + '.png'), (await window.webContents.capturePage()).toPNG())
  }
  const task = async title => {
    await evaluate("(()=>{const row=[...document.querySelectorAll('.task-row')].find(e=>e.querySelector('strong').textContent===" + JSON.stringify(title) + ");if(!row)throw new Error('Missing task: '+" + JSON.stringify(title) + ");row.click()})()")
    await paint()
  }
  const calls = name => evaluate("window.togleUITest.calls().filter(call=>call.name===" + JSON.stringify(name) + ")")
  await window.loadFile(process.env.TOGLE_UI_RENDERER || path.join(project, 'out/renderer/index.html'))
  await wait("!!document.querySelector('.workspace-nav')")
  return { window, errors, evaluate, paint, wait, click, fill, capture, calls, task }
}

const texts = (ui, selector) => ui.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].map(e=>e.textContent.trim().replace(/\\s+/g,' '))")

/** The titles under one heading of the list. */
const groupTitles = (ui, heading) => ui.evaluate("(()=>{const group=[...document.querySelectorAll('.task-group')].find(g=>g.querySelector('h3').textContent===" + JSON.stringify(heading) + ");return group?[...group.querySelectorAll('.task-copy strong')].map(e=>e.textContent):null})()")

async function checkTasks(T, agent) {
  const ui = await open(T, agent, 1024)
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.workspace-nav button')].map(button=>button.getAttribute('aria-label'))"), ['Tasks', 'Explore agents'])
  await ui.click('.workspace-nav button', 'Tasks')
  await ui.wait("document.querySelectorAll('.task-row').length===6")
  assert.deepEqual(await texts(ui, '.task-group > h3'), ['Waiting for you', 'Working', 'Earlier · 2 tasks'])
  const rows = await ui.evaluate("[...document.querySelectorAll('.task-row')].map(row=>({title:row.querySelector('strong').textContent,state:row.dataset.state,more:row.querySelector('.task-copy span').textContent,danger:!!row.querySelector('.task-danger')}))")
  assert.deepEqual(rows.map(row => row.title), ['Add the status column', 'Clean the build folder', 'Rebuild the pricing page', 'Write the release notes', 'Fix the login redirect', 'Port the settings screen'])
  assert.equal(rows[0].more, 'Codex · api-server · Wants to run npm run migrate')
  assert.deepEqual(rows.map(row => row.danger), [false, true, false, false, false, false], 'only the command that looks dangerous is marked in the list')
  assert.equal(rows[3].more, 'Claude Code · notes · Working in its own window')
  assert.ok(/ago|yesterday/.test(rows[4].more) && /days ago/.test(rows[5].more), 'earlier tasks say when they were last worked on')
  assert.ok((await texts(ui, '.tasks-found'))[0].includes('Found: Claude Code, Codex'))
  assert.ok(!(await texts(ui, '.tasks-found'))[0].includes('Hermes'), 'an agent that is not installed is not listed as found')
  await ui.capture('tasks-list')

  // A command waits: shown in full, allowed once.
  await ui.task('Add the status column')
  await ui.wait("!!document.querySelector('.task-request')")
  assert.equal(await ui.evaluate("document.querySelector('.task-request .task-command').textContent"), 'npm run migrate')
  assert.deepEqual(await texts(ui, '.task-request button'), ['Allow once', 'Refuse'])
  assert.equal(await ui.evaluate("!!document.querySelector('.task-request .task-danger')"), false)
  assert.deepEqual(await texts(ui, '.task-log .task-you'), ['Add a status column to the orders table.'])
  await ui.capture('tasks-request')
  await ui.click('.task-request button', 'Allow once')
  await ui.wait("!document.querySelector('.task-request')")
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args), [['codex:t1', 'r1', 'allow-once']])
  assert.ok((await texts(ui, '.task-note')).includes('You allowed it.'), 'the answer is written down')
  assert.equal(await ui.evaluate("document.querySelector('.task-state').textContent"), 'Working')
  await ui.wait("[...document.querySelectorAll('.task-group')].find(group=>group.querySelector('h3').textContent==='Waiting for you').querySelectorAll('.task-row').length===1")
  assert.deepEqual(await groupTitles(ui, 'Working'), ['Rebuild the pricing page', 'Write the release notes', 'Add the status column'], 'an answered task moves from waiting to working')

  // A command that looks dangerous says so, with the reason, and is refused.
  await ui.task('Clean the build folder')
  await ui.wait("!!document.querySelector('.task-request.danger')")
  assert.equal(await ui.evaluate("document.querySelector('.task-request .task-danger').textContent"), 'Dangerous')
  assert.ok((await texts(ui, '.task-why'))[0].startsWith('It deletes files or folders for good.'))
  await ui.capture('tasks-danger')
  await ui.click('.task-request button', 'Refuse')
  await ui.wait("!document.querySelector('.task-request')")
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args[2]), ['allow-once', 'refuse'])

  // A task that works: Stop, and for Codex the second press.
  await ui.task('Rebuild the pricing page')
  await ui.wait("!!document.querySelector('.task-cmd')")
  assert.deepEqual(await texts(ui, '.task-cmd code'), ['npm test'])
  assert.equal(await ui.evaluate("document.querySelector('.task-cmd').dataset.status"), 'running')
  assert.equal(await ui.evaluate("document.querySelector('.task-cmd .hint').textContent"), 'running')
  assert.equal(await ui.evaluate("document.querySelector('.task-agent strong')?.textContent"), 'Two plans', 'the agent\'s words are formatted')
  assert.deepEqual(await texts(ui, '.task-actions button'), ['Stop'])
  await ui.capture('tasks-working')
  await ui.click('.task-actions button', 'Stop')
  await ui.wait("document.querySelector('.task-state')?.textContent==='Stopped'")
  assert.deepEqual((await ui.calls('stopRunnerTask')).map(call => call.args), [['claude:s2']])
  assert.deepEqual(await texts(ui, '.task-actions button'), ['Let go'], 'a stopped Claude Code task has no second press')
  await ui.click('.task-actions button', 'Let go')
  await ui.wait("document.querySelector('.task-banner')")
  assert.deepEqual((await ui.calls('closeRunnerTask')).map(call => call.args), [['claude:s2']])
  assert.ok((await texts(ui, '.task-banner'))[0].includes('Togle is not running this task'))
  await ui.click('.task-banner button', 'Continue here')
  await ui.wait("!document.querySelector('.task-banner')")
  assert.deepEqual((await ui.calls('openRunnerTask')).map(call => call.args), [['claude:s2']])

  // A reply goes to the task.
  await ui.fill('.task-reply input', 'Use three plans instead')
  await ui.click('.task-reply button', 'Send')
  await ui.wait("[...document.querySelectorAll('.task-you')].some(e=>e.textContent==='Use three plans instead')")
  assert.deepEqual((await ui.calls('sendToRunnerTask')).map(call => call.args), [['claude:s2', 'Use three plans instead']])
  assert.equal(await ui.evaluate("document.querySelector('.task-reply input').value"), '', 'the box is empty after sending')

  // A task in a terminal can be seen and, after a warning, taken over.
  await ui.task('Write the release notes')
  await ui.wait("!!document.querySelector('.task-banner')")
  assert.equal(await ui.evaluate("!!document.querySelector('.task-reply')"), false, 'what Togle does not run cannot be replied to')
  await ui.click('.task-banner button', 'Take over')
  assert.ok((await texts(ui, '.task-banner'))[0].includes('This ends the Claude Code running in its terminal'))
  assert.equal((await ui.calls('takeOverRunnerTask')).length, 0, 'nothing is ended before the second click')
  await ui.click('.task-banner button', 'Cancel')
  await ui.click('.task-banner button', 'Take over')
  await ui.click('.task-banner button', 'End it and take over')
  await ui.wait("!document.querySelector('.task-banner')")
  assert.deepEqual((await ui.calls('takeOverRunnerTask')).map(call => call.args), [['claude:s4']])

  // Codex: Stop ends the turn and leaves the command, and the second press ends it.
  await ui.task('Add the status column')
  await ui.wait("!!document.querySelector('.task-actions .stop')")
  await ui.click('.task-actions button', 'Stop')
  await ui.wait("[...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='End the running command')")
  await ui.click('.task-actions button', 'End the running command')
  await ui.wait("![...document.querySelectorAll('.task-actions button')].some(b=>b.textContent==='End the running command')")
  assert.deepEqual((await ui.calls('endRunnerCommands')).map(call => call.args), [['codex:t1']])

  // A new task: the agent, the folder, what to do.
  await ui.click('.tasks-head button', 'New task')
  await ui.wait("!!document.querySelector('.task-new')")
  assert.deepEqual(await texts(ui, '.task-new-agents label'), ['Claude Code', 'Codex'], 'only agents that are installed can be picked')
  assert.equal(await ui.evaluate("document.querySelector('.task-new .primary').disabled"), true)
  await ui.click('.task-new-agents label', 'Codex')
  await ui.click('.task-new button', 'Choose…')
  await ui.wait("document.querySelector('.task-new-folder input').value==='C:\\\\work\\\\picked'")
  await ui.fill('.task-new textarea', 'Add a dark mode switch to the settings page')
  await ui.capture('tasks-new')
  await ui.click('.task-new .primary', 'Start')
  await ui.wait("document.querySelector('.task-title h2')?.textContent==='Add a dark mode switch to the settings p'")
  assert.deepEqual((await ui.calls('startRunnerTask')).map(call => call.args), [[{ runner: 'codex', folder: 'C:\\work\\picked', prompt: 'Add a dark mode switch to the settings page' }]])
  assert.equal(await ui.evaluate("document.querySelector('.task-state').textContent"), 'Working')

  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkQuit(T, agent) {
  const ui = await open(T, agent, 1024)
  const notice = () => ui.evaluate("document.querySelector('[aria-label=\"Confirm quit Togle\"] span')?.textContent ?? null")
  const warn = warning => ui.evaluate("window.togleUITest.emit('onConfirmClose', " + JSON.stringify(warning) + ")")

  // A task that has not finished: the question names it, Keep going leaves it, and Quit goes ahead.
  await warn({ call: false, tasks: ['Add the status column'] })
  await ui.wait("!!document.querySelector('[aria-label=\"Confirm quit Togle\"]')")
  assert.equal(await notice(), 'Quit Togle? “Add the status column” has not finished. Quitting stops it. You can continue it from Tasks.')
  await ui.capture('tasks-quit')
  await ui.click('[aria-label="Confirm quit Togle"] button', 'Keep going')
  await ui.wait("!document.querySelector('[aria-label=\"Confirm quit Togle\"]')")
  assert.equal((await ui.calls('close')).length, 0, 'Keep going quits nothing')
  await warn({ call: false, tasks: ['One', 'Two'] })
  await ui.wait("!!document.querySelector('[aria-label=\"Confirm quit Togle\"]')")
  assert.equal(await notice(), 'Quit Togle? 2 tasks have not finished. Quitting stops them. You can continue them from Tasks.')
  await ui.click('[aria-label="Confirm quit Togle"] button', 'Quit Togle')
  assert.deepEqual((await ui.calls('close')).map(call => call.args), [[true]])

  // A call alone is asked as it always was; a call with tasks says both; Escape means Keep going.
  await warn({ call: true, tasks: [] })
  await ui.wait("!!document.querySelector('[aria-label=\"Confirm quit Togle\"]')")
  assert.equal(await notice(), 'Quit Togle? Call assistance and dictation will stop. Your call is saved.')
  await warn({ call: true, tasks: ['One'] })
  await ui.wait("document.querySelector('[aria-label=\"Confirm quit Togle\"] span').textContent.includes('so will a task')")
  await ui.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
  await ui.wait("!document.querySelector('[aria-label=\"Confirm quit Togle\"]')")
  assert.equal((await ui.calls('close')).length, 1, 'Escape quits nothing')
  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkNarrow(T, agent) {
  const ui = await open(T, agent, 600)
  await ui.click('.workspace-nav button', 'Tasks')
  await ui.wait("document.querySelectorAll('.task-row').length===6")
  const fits = () => ui.evaluate("document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.tasks').scrollWidth<=document.querySelector('.tasks').clientWidth+1")
  assert.ok(await fits(), 'the list fits a narrow window')
  assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.tasks-detail')).display"), 'none', 'a narrow window shows the list first')
  await ui.task('Add the status column')
  await ui.wait("!!document.querySelector('.task-request')")
  assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.tasks-list')).display"), 'none', 'then the task alone')
  assert.ok(await fits(), 'a task fits a narrow window')
  await ui.capture('tasks-narrow')
  await ui.click('.tasks-back', 'Back to the list')
  await ui.wait("getComputedStyle(document.querySelector('.tasks-list')).display!=='none'")
  assert.deepEqual(ui.errors, [])
  ui.window.destroy()
}

app.whenReady().then(async () => {
  try {
    const T = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
    const store = new T.AgentStore(async () => '')
    await store.load()
    const agent = store.list()[0]
    await checkTasks(T, agent)
    await checkNarrow(T, agent)
    await checkQuit(T, agent)
    console.log('Tasks screen: list, requests, danger mark, stop and second press, reply, continue, take over, new task, narrow layout and the question before quitting passed')
    clearTimeout(timeout)
    app.quit()
  } catch (error) {
    console.error(error.stack || error)
    clearTimeout(timeout)
    app.exit(1)
  }
})
