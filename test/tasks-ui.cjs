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

async function open(T, agent, width, surface) {
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
  await window.loadFile(process.env.TOGLE_UI_RENDERER || path.join(project, 'out/renderer/index.html'), surface ? { query: { surface } } : undefined)
  await wait(surface ? "document.body.classList.contains('" + surface + "-surface')" : "!!document.querySelector('.workspace-nav')")
  return { window, errors, evaluate, paint, wait, click, fill, capture, calls, task }
}

const texts = (ui, selector) => ui.evaluate("[...document.querySelectorAll(" + JSON.stringify(selector) + ")].map(e=>e.textContent.trim().replace(/\\s+/g,' '))")

/** The titles under one heading of the list. */
const groupTitles = (ui, heading) => ui.evaluate("(()=>{const group=[...document.querySelectorAll('.task-group')].find(g=>g.querySelector('h3').textContent===" + JSON.stringify(heading) + ");return group?[...group.querySelectorAll('.task-copy strong')].map(e=>e.textContent):null})()")

async function checkTasks(T, agent) {
  const ui = await open(T, agent, 1024)
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.workspace-nav button')].map(button=>button.getAttribute('aria-label'))"), ['To-do', 'Tasks', 'Explore agents'])
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

async function checkTodo(T, agent) {
  const ui = await open(T, agent, 1024)
  await ui.click('.workspace-nav button', 'To-do')
  await ui.wait("document.querySelectorAll('.todo-item').length===4")
  const todo = () => texts(ui, '.todo-item .todo-text')
  assert.equal(await ui.evaluate("document.querySelector('.todo-head h2').textContent"), new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), 'the day')
  assert.equal(await ui.evaluate("document.querySelector('.todo-add input').placeholder"), 'Add a to-do, or hold F9 and say it')

  // What waits for the person is on top, a command in full before it can be allowed, and one that looks dangerous only in the window.
  assert.deepEqual(await texts(ui, '.todo-group > h3'), ['Waiting for you', 'To do'])
  assert.deepEqual(await texts(ui, '.todo-row.need b'), ['Add the status column', 'Clean the build folder'])
  assert.equal((await texts(ui, '.todo-row.need small'))[0], 'Codex · api-server · wants to run')
  assert.deepEqual(await texts(ui, '.todo-row.need .todo-command'), ['npm run migrate', 'rm -rf build'])
  assert.deepEqual(await texts(ui, '.todo-row.need:nth-child(1) button'), ['Allow once', 'Refuse', 'Open'])
  assert.deepEqual(await texts(ui, '.todo-row.need:nth-child(2) button'), ['Refuse', 'Open'], 'a command that looks dangerous is not allowed from a row')
  assert.equal(await ui.evaluate("document.querySelector('.todo-row.need:nth-child(2) .task-danger').textContent"), 'Dangerous')
  await ui.capture('todo-list')

  // The list: open items first, the ticked one last and struck through, a chip for what an agent does with an item.
  assert.deepEqual(await todo(), ['Review the onboarding copy', 'Fix the login redirect', 'Write the release notes', 'Send the invoice to Marta'])
  assert.deepEqual(await texts(ui, '.todo-chip'), ['Claude Code · working', 'Claude Code · done'])
  assert.equal(await ui.evaluate("document.querySelector('.todo-item.done .todo-text').textContent"), 'Send the invoice to Marta')
  assert.equal(await ui.evaluate("getComputedStyle(document.querySelector('.todo-item.done .todo-text')).textDecorationLine"), 'line-through')
  assert.deepEqual(await texts(ui, '.todo-item .todo-row > button.small'), ['Give to an agent', 'See changes'], 'only an item with no agent can be given, and only one whose agent is done has changes to see')
  assert.ok((await texts(ui, '.todo-file'))[0].startsWith('Your list is a plain text file on this computer.'))

  // Allow once and Refuse go to the task.
  await ui.click('.todo-row.need button', 'Allow once')
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args), [['codex:t1', 'r1', 'allow-once']])
  await ui.wait("document.querySelectorAll('.todo-row.need').length===1")
  await ui.click('.todo-row.need button', 'Refuse')
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args[2]), ['allow-once', 'refuse'])
  await ui.wait("!document.querySelector('.todo-row.need')")
  assert.deepEqual(await texts(ui, '.todo-group > h3'), ['To do'], 'nothing waits, so that part is not there')

  // Add, tick, change, delete.
  await ui.fill('.todo-add input', '  Call the bank  ')
  await ui.evaluate("document.querySelector('.todo-add').requestSubmit()")
  await ui.wait("document.querySelectorAll('.todo-item').length===5")
  assert.deepEqual((await ui.calls('addTodo')).map(call => call.args), [['Call the bank']])
  assert.equal(await ui.evaluate("document.querySelector('.todo-add input').value"), '', 'the box is empty after adding')
  await ui.click('.todo-box', 'Tick: Review the onboarding copy')
  await ui.wait("document.querySelectorAll('.todo-item.done').length===2")
  assert.deepEqual((await ui.calls('setTodoDone')).map(call => call.args), [[{ line: 0, text: 'Review the onboarding copy' }, true]])
  assert.deepEqual(await todo(), ['Fix the login redirect', 'Write the release notes', 'Call the bank', 'Review the onboarding copy', 'Send the invoice to Marta'], 'a ticked item moves below the open ones')
  await ui.click('.todo-box', 'Untick: Review the onboarding copy')
  await ui.wait("document.querySelectorAll('.todo-item.done').length===1")
  await ui.click('.todo-text', 'Call the bank')
  await ui.wait("!!document.querySelector('.todo-edit')")
  await ui.fill('.todo-edit', 'Call the bank about the card')
  await ui.evaluate("document.querySelector('.todo-edit').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await ui.wait("!!document.querySelector('.todo-text') && [...document.querySelectorAll('.todo-text')].some(e=>e.textContent==='Call the bank about the card')")
  assert.deepEqual((await ui.calls('editTodo')).map(call => call.args), [[{ line: 4, text: 'Call the bank' }, 'Call the bank about the card']])
  await ui.click('.todo-remove', 'Delete: Call the bank about the card')
  await ui.wait("document.querySelectorAll('.todo-item').length===4")
  assert.deepEqual((await ui.calls('removeTodo')).map(call => call.args), [[{ line: 4, text: 'Call the bank about the card' }]])

  // Give an item to an agent: the form has its words, and the item is linked to the task that starts.
  assert.deepEqual(await todo(), ['Review the onboarding copy', 'Fix the login redirect', 'Write the release notes', 'Send the invoice to Marta'], 'unticked, it is back where it was in the file')
  await ui.click('.todo-item .todo-row > button.small', 'Give to an agent')
  await ui.wait("!!document.querySelector('.todo-give .task-new')")
  assert.equal(await ui.evaluate("document.querySelector('.todo-give .task-new h2').textContent"), 'Give to an agent')
  assert.equal(await ui.evaluate("document.querySelector('.todo-give textarea').value"), 'Review the onboarding copy', 'the task has the item\'s words')
  assert.deepEqual(await texts(ui, '.todo-give .task-new-agents label'), ['Claude Code', 'Codex'])
  await ui.capture('todo-give')
  await ui.click('.todo-give .task-new .primary', 'Start')
  await ui.wait("!document.querySelector('.todo-give')")
  assert.deepEqual((await ui.calls('startRunnerTask')).map(call => call.args[0]), [{ runner: 'claude', folder: 'C:\\work\\website', prompt: 'Review the onboarding copy', title: 'Review the onboarding copy' }], 'the folder is the one most recently used')
  const linked = await ui.calls('linkTodo')
  assert.equal(linked.length, 1)
  assert.deepEqual(linked[0].args[0], { line: 0, text: 'Review the onboarding copy' }, 'the item as it was when the person looked')
  assert.ok(/^claude:new\d+$/.test(linked[0].args[1]), 'linked to the task that started: ' + linked[0].args[1])
  await ui.wait("document.querySelectorAll('.todo-chip').length===3")
  assert.equal(await ui.evaluate("document.querySelector('.todo-item:nth-child(1) .todo-chip').textContent"), 'Claude Code · working')
  assert.deepEqual(await texts(ui, '.todo-item .todo-row > button.small'), ['See changes'], 'an item with an agent cannot be given again')

  // A chip opens the task, and Show the file shows the file.
  await ui.click('.todo-item:nth-child(2) .todo-chip', 'Claude Code · working')
  await ui.wait("!!document.querySelector('.tasks')")
  assert.equal(await ui.evaluate("document.querySelector('.task-title h2')?.textContent"), 'Rebuild the pricing page', 'the Tasks screen opens on that task')
  await ui.click('.workspace-nav button', 'To-do')
  await ui.wait("!!document.querySelector('.todo')")
  await ui.click('.todo-file button', 'Show the file')
  assert.equal((await ui.calls('showTodoFile')).length, 1)

  // An item that was changed under the person's hands says so, and the list is shown again as it is.
  await ui.evaluate("window.togle.removeTodo({line:3,text:'Send the invoice to Marta'}).then(()=>window.togleUITest.emit('onTodoChanged'))")
  await ui.wait("document.querySelectorAll('.todo-item').length===3")
  await ui.click('.todo-text', 'Fix the login redirect')
  await ui.evaluate("window.togle.removeTodo({line:1,text:'Fix the login redirect'})")
  await ui.fill('.todo-edit', 'Fix the login redirect and the logout')
  await ui.evaluate("document.querySelector('.todo-edit').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await ui.wait("!!document.querySelector('.todo .error')")
  assert.ok((await texts(ui, '.todo .error'))[0].startsWith('The list changed while you were looking at it'))
  await ui.wait("document.querySelectorAll('.todo-item').length===2")
  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkChanges(T, agent) {
  const ui = await open(T, agent, 1024)
  await ui.click('.workspace-nav button', 'Tasks')
  await ui.wait("document.querySelectorAll('.task-row').length===6")

  // From a task: the files, and what changed in the one that is picked.
  await ui.task('Rebuild the pricing page')
  await ui.wait("!!document.querySelector('.task-title .link')")
  await ui.click('.task-title .link', 'See changes')
  await ui.wait("!!document.querySelector('.changes-file')")
  assert.deepEqual((await ui.calls('runnerChanges')).map(call => call.args), [['claude:s2']])
  assert.equal(await ui.evaluate("document.querySelector('.changes .task-title h2').textContent"), 'Changes in website')
  assert.ok((await texts(ui, '.changes > .hint'))[0].startsWith('Everything in this folder that differs from the last commit on main.'))
  assert.deepEqual(await texts(ui, '.changes-file'), ['changedsrc/status.ts+1 −1', 'newmigrations/003_add_status.sql+2 −0'])
  assert.equal(await ui.evaluate("document.querySelector('.changes-file.on .changes-path').textContent"), 'src/status.ts', 'the first file is open')
  assert.deepEqual(await ui.evaluate("[...document.querySelectorAll('.changes-diff .diff-line')].map(line=>line.className.replace('diff-line ','')+':'+line.textContent.trim())"), [
    'meta:diff --git a/src/status.ts b/src/status.ts', 'meta:index 1111111..2222222 100644', 'meta:--- a/src/status.ts', 'meta:+++ b/src/status.ts', 'hunk:@@ -1,3 +1,3 @@',
    "plain:export const columns = ['id', 'name']", "add:+export const status = 'status'", 'del:-const old = 1', 'plain:export default columns', 'plain:'
  ])
  await ui.capture('tasks-changes')
  await ui.click('.changes-file', 'newmigrations/003_add_status.sql+2 −0')
  assert.equal(await ui.evaluate("document.querySelector('.changes-diff').getAttribute('aria-label')"), 'Changes in migrations/003_add_status.sql')
  assert.equal(await ui.evaluate("document.querySelectorAll('.changes-diff .diff-line.add').length"), 2, 'the new file is all added, and its +++ line is not one of the added lines')
  await ui.click('.changes .tasks-back-to-task', 'Back to the task')
  await ui.wait("!!document.querySelector('.task-panel')")
  assert.equal(await ui.evaluate("document.querySelector('.task-title h2').textContent"), 'Rebuild the pricing page')

  // A folder that is not in a repository says so.
  await ui.task('Write the release notes')
  await ui.click('.task-title .link', 'See changes')
  await ui.wait("!!document.querySelector('.changes-problem')")
  assert.equal((await texts(ui, '.changes-problem'))[0], 'This folder is not in a git repository, so Togle cannot tell what changed.')
  assert.equal(await ui.evaluate("!!document.querySelector('.changes-file')"), false)

  // From the to-do list: a finished item has See changes, and it opens on them.
  await ui.click('.workspace-nav button', 'To-do')
  await ui.wait("document.querySelectorAll('.todo-item').length===4")
  await ui.click('.todo-item .todo-row > button.small', 'See changes')
  await ui.wait("!!document.querySelector('.changes')")
  assert.equal(await ui.evaluate("document.querySelector('.changes .task-title p').textContent"), 'Fix the login redirect', 'the task the item was given to (a task has its own title)')
  assert.deepEqual((await ui.calls('runnerChanges')).map(call => call.args[0]).slice(-1), ['claude:s3'])
  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkOutside(T, agent) {
  const ui = await open(T, agent, 1024)
  await ui.click('.workspace-nav button', 'Tasks')
  await ui.wait("document.querySelectorAll('.task-row').length===6")

  // Claude Code in a terminal: asking Togle is off until the person connects it, with the file it changes named.
  await ui.wait("!!document.querySelector('.tasks-connect')")
  assert.ok((await texts(ui, '.tasks-connect p'))[0].startsWith('Answer from here.'))
  assert.deepEqual(await texts(ui, '.tasks-connect button'), ['Connect Claude Code'])
  assert.equal(await ui.evaluate("document.querySelector('.tasks-connect details code').textContent"), 'C:\\Users\\demo\\.claude\\settings.json', 'the file it changes is named')
  assert.ok((await texts(ui, '.tasks-connect details p'))[0].includes('Turn off takes the entry out again.'))
  await ui.capture('tasks-connect')
  await ui.evaluate("window.togleUITest.failNextConnect()")
  await ui.click('.tasks-connect button', 'Connect Claude Code')
  await ui.wait("!!document.querySelector('.tasks-connect .error')")
  assert.equal((await texts(ui, '.tasks-connect .error'))[0], "Claude Code's settings file is not valid JSON, so Togle left it alone.")
  assert.deepEqual(await texts(ui, '.tasks-connect button'), ['Connect Claude Code'], 'still not connected, and it can be tried again')
  await ui.click('.tasks-connect button', 'Connect Claude Code')
  await ui.wait("!document.querySelector('.tasks-connect .error') && document.querySelector('.tasks-connect strong')?.textContent==='Connected.'")
  assert.equal((await ui.calls('connectClaudeHook')).length, 2)
  assert.deepEqual(await texts(ui, '.tasks-connect button'), ['Turn off'])
  await ui.click('.tasks-connect button', 'Turn off')
  await ui.wait("document.querySelector('.tasks-connect strong')?.textContent==='Answer from here.'")
  assert.equal((await ui.calls('disconnectClaudeHook')).length, 1)
  // Togle moved since: connect again. An old Claude Code cannot run the hook, and says so.
  const leaveAndReturn = async () => {
    await ui.click('.workspace-nav button', 'To-do')
    await ui.wait("!!document.querySelector('.todo')")
    await ui.click('.workspace-nav button', 'Tasks')
    await ui.wait("!!document.querySelector('.tasks-connect')")
  }
  await ui.evaluate("window.togleUITest.hook({ installed: true, current: false })")
  await leaveAndReturn()
  await ui.wait("document.querySelector('.tasks-connect strong')?.textContent==='Togle has moved since this was set up.'")
  assert.deepEqual(await texts(ui, '.tasks-connect button'), ['Connect again'])
  await ui.evaluate("window.togleUITest.hook({ installed: false, current: false, supported: false, version: '2.0.30 (Claude Code)' })")
  await leaveAndReturn()
  assert.equal((await texts(ui, '.tasks-connect'))[0], 'Claude Code 2.0.30 is older than 2.1.139, so Togle cannot answer its terminal sessions. Update Claude Code to use this.')
  assert.deepEqual(await texts(ui, '.tasks-connect button'), [])
  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkOutsideAsk(T, agent) {
  const ui = await open(T, agent, 1024)
  await ui.click('.workspace-nav button', 'Tasks')
  await ui.wait("document.querySelectorAll('.task-row').length===6")
  // A session in a terminal asks about a command: it waits, and can be answered here as well as there.
  await ui.evaluate("window.togleUITest.askOutside('claude:s4', { id: 'ext-1', kind: 'command', command: 'npm run build', raw: 'npm run build', folder: 'C:\\\\work\\\\notes', offersAlways: false })")
  await ui.wait("document.querySelector('.task-row[data-state=waiting] strong')")
  await ui.task('Write the release notes')
  await ui.wait("!!document.querySelector('.task-request')")
  assert.equal(await ui.evaluate("document.querySelector('.task-request .task-command').textContent"), 'npm run build')
  assert.deepEqual(await texts(ui, '.task-request button'), ['Allow once', 'Refuse'])
  assert.equal((await texts(ui, '.task-banner'))[0].startsWith('It runs in its own window and asks there too. Answer here or there: the first answer counts.'), true)
  await ui.capture('tasks-outside')
  await ui.click('.task-request button', 'Allow once')
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args), [['claude:s4', 'ext-1', 'allow-once']])
  await ui.wait("!document.querySelector('.task-request')")
  // The same question on the to-do list: the command in full, and the buttons.
  await ui.evaluate("window.togleUITest.askOutside('claude:s4', { id: 'ext-2', kind: 'command', command: 'git status', raw: 'git status', folder: 'C:\\\\work\\\\notes', offersAlways: false })")
  await ui.click('.workspace-nav button', 'To-do')
  await ui.wait("[...document.querySelectorAll('.todo-row.need b')].some(b=>b.textContent==='Write the release notes')")
  const row = "[...document.querySelectorAll('.todo-row.need')].find(r=>r.querySelector('b').textContent==='Write the release notes')"
  assert.equal(await ui.evaluate(row + ".querySelector('.todo-command').textContent"), 'git status')
  assert.deepEqual(await ui.evaluate("[..." + row + ".querySelectorAll('button')].map(b=>b.textContent)"), ['Allow once', 'Refuse', 'Open'])
  await ui.evaluate(row + ".querySelectorAll('button')[1].click()")
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args[2]), ['allow-once', 'refuse'])
  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkTaskBox(T, agent) {
  const ui = await open(T, agent, 600, 'taskbox')
  await ui.wait("document.querySelectorAll('.taskbox-agents button').length===2")
  assert.deepEqual(await texts(ui, '.taskbox-agents button'), ['Claude Code', 'Codex'], 'only the agents that are installed')
  assert.equal(await ui.evaluate("document.querySelector('.taskbox-agents button').getAttribute('aria-checked')"), 'true', 'the first is picked')
  await ui.wait("document.querySelectorAll('.taskbox-folder option').length===4")
  assert.deepEqual(await texts(ui, '.taskbox-folder option'), ['api-server', 'website', 'notes', 'mobile-app'], 'the folders tasks were in lately')
  assert.equal(await ui.evaluate("document.querySelector('.taskbox-folder select').value"), 'C:\\work\\api-server')
  assert.equal(await ui.evaluate("document.querySelector('.taskbox textarea').placeholder"), 'Say what to do. Hold F9 to say it, then press Enter.')
  assert.equal(await ui.evaluate("document.querySelector('.taskbox-foot .primary').disabled"), true, 'nothing to start yet')
  assert.ok((await texts(ui, '.taskbox-foot span'))[0].startsWith('It asks before every command and every change.'))
  await ui.capture('task-box')

  // Another agent, another folder, the words: Enter starts it and puts the box away. Shift+Enter is a new line.
  await ui.click('.taskbox-agents button', 'Codex')
  await ui.click('.taskbox-folder button', 'Choose…')
  await ui.wait("document.querySelector('.taskbox-folder select').value==='C:\\\\work\\\\chosen-for-box'")
  assert.equal((await ui.calls('pickTaskBoxFolder')).length, 1)
  assert.ok((await texts(ui, '.taskbox-folder option')).includes('chosen-for-box'))
  await ui.fill('.taskbox textarea', 'Add a dark mode switch')
  await ui.evaluate("document.querySelector('.taskbox textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}))")
  assert.equal((await ui.calls('startRunnerTask')).length, 0, 'Shift+Enter does not start')
  await ui.evaluate("window.togleUITest.failNextTask()")
  await ui.evaluate("document.querySelector('.taskbox textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))")
  await ui.wait("!!document.querySelector('.taskbox-error')")
  assert.equal((await texts(ui, '.taskbox-error'))[0], 'That folder is not there.')
  assert.equal(await ui.evaluate("document.querySelector('.taskbox textarea').value"), 'Add a dark mode switch', 'what was typed is still there')
  assert.equal((await ui.calls('closeTaskBox')).length, 0, 'and the box stays')
  await ui.evaluate("document.querySelector('.taskbox textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))")
  await ui.wait("document.querySelector('.taskbox textarea').value===''")
  const asked = { runner: 'codex', folder: 'C:\\work\\chosen-for-box', prompt: 'Add a dark mode switch' }
  assert.deepEqual((await ui.calls('startRunnerTask')).map(call => call.args[0]), [asked, asked], 'the first try failed, and the second started it')
  assert.equal((await ui.calls('closeTaskBox')).length, 1, 'started: the box is put away')

  // Escape puts it away. The choice is kept for the next time it opens.
  await ui.evaluate("document.querySelector('.taskbox textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
  assert.equal((await ui.calls('closeTaskBox')).length, 2)
  await ui.window.webContents.reload()
  await ui.wait("document.querySelectorAll('.taskbox-agents button').length===2")
  assert.equal(await ui.evaluate("document.querySelector('.taskbox-agents button[aria-checked=true]').textContent"), 'Codex', 'the agent used last')
  assert.equal(await ui.evaluate("document.querySelector('.taskbox-folder select').value"), 'C:\\work\\chosen-for-box', 'and the folder')
  assert.deepEqual(ui.errors, [], 'no errors in the console')
  ui.window.destroy()
}

async function checkAgentSettings(T, agent) {
  const ui = await open(T, agent, 1024)
  await ui.click('.sidebar-settings', 'Settings')
  await ui.wait("!!document.querySelector('#settings-agents')")
  const section = "document.querySelector('#settings-agents')"
  assert.deepEqual(await ui.evaluate(`[...${section}.querySelectorAll('.setting .name')].map(e=>e.textContent)`), ['Notice when a task waits', 'Notice when a task finishes', 'Start a task for a coding agent', 'Claude Code in a terminal', 'To-do list'])
  assert.deepEqual(await ui.evaluate(`[...${section}.querySelectorAll('input[role=switch]')].map(e=>[e.checked,e.disabled])`), [[true, false], [true, false]], 'both notices are on to begin with')
  assert.ok((await ui.evaluate(`${section}.textContent`)).includes('F10'), 'the key that opens the task box')
  await ui.evaluate(`${section}.scrollIntoView({ block: 'start' })`)
  await ui.capture('settings-agents')
  await ui.evaluate(`${section}.querySelectorAll('input[role=switch]')[0].click()`)
  await ui.wait(`${section}.querySelectorAll('input[role=switch]')[0].checked===false`)
  assert.deepEqual((await ui.calls('updateSettings')).map(call => call.args).filter(patch => patch?.tasks), [{ tasks: { notices: false } }])
  assert.equal(await ui.evaluate(`${section}.querySelectorAll('input[role=switch]')[1].disabled`), true, 'the one for finished waits for the first')
  await ui.evaluate(`${section}.querySelectorAll('input[role=switch]')[0].click()`)
  await ui.wait(`${section}.querySelectorAll('input[role=switch]')[0].checked===true`)
  // Claude Code in a terminal, and the to-do list's file.
  assert.deepEqual(await texts(ui, '#settings-agents .tasks-connect-compact button'), ['Connect Claude Code'])
  await ui.click('#settings-agents .tasks-connect-compact button', 'Connect Claude Code')
  await ui.wait("document.querySelector('#settings-agents .tasks-connect-compact .hint')?.textContent==='Connected'")
  assert.equal((await ui.calls('connectClaudeHook')).length, 1)
  assert.deepEqual(await texts(ui, '#settings-agents .tasks-connect-compact button'), ['Turn off'])
  await ui.wait("[...document.querySelectorAll('#settings-agents .setting')].some(row=>row.textContent.includes('settings')===false&&row.querySelector('code'))")
  assert.equal((await texts(ui, '#settings-agents .setting code'))[0], 'C:\\Users\\demo\\AppData\\Roaming\\Togle\\to-do.md')
  await ui.click('#settings-agents button', 'Show the file')
  assert.equal((await ui.calls('showTodoFile')).length, 1)
  assert.equal(await ui.evaluate("[...document.querySelectorAll('.settings-jump button')].some(b=>b.textContent==='Coding agents')"), true, 'it is in the list of parts at the top')
  assert.ok(!(await ui.evaluate("document.querySelector('#settings-window').textContent")).includes('Start a task for a coding agent'), 'and not again among the other shortcuts')
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

async function checkNotice(T, agent) {
  const ui = await open(T, agent, 392, 'notice')
  const emit = value => ui.evaluate("window.togleUITest.emit('onTaskNotice', " + JSON.stringify(value) + ")")
  const waiting = (extra = {}) => ({ id: 'codex:t1#r1', kind: 'waiting', key: 'codex:t1', title: 'Add the status column', where: 'Codex · api-server', says: 'wants to run', detail: 'npm run migrate', detailKind: 'command', requestId: 'r1', canRefuse: true, canAllow: true, others: 0, ...extra })
  const buttons = () => texts(ui, '.task-notice-actions button')
  const disabled = label => ui.evaluate("[...document.querySelectorAll('.task-notice-actions button')].find(b=>b.textContent==='" + label + "').disabled")
  assert.equal(await ui.evaluate("document.querySelector('.task-notice')"), null, 'nothing shows until there is something to say')

  // A command that waits: shown in full; Allow once cannot be pressed the moment the notice appears, Refuse can.
  await emit(waiting({ others: 2 }))
  await ui.wait("!!document.querySelector('.task-notice')")
  assert.equal(await ui.evaluate("document.querySelector('.task-notice-head strong').textContent"), 'Add the status column')
  assert.equal((await texts(ui, '.task-notice-says'))[0], 'Codex · api-server wants to run')
  assert.equal(await ui.evaluate("document.querySelector('.task-notice-detail').textContent"), 'npm run migrate')
  assert.deepEqual(await buttons(), ['Allow once', 'Refuse', 'Open'])
  assert.equal(await disabled('Allow once'), true, 'a click meant for what was under the notice cannot allow a command')
  assert.equal(await disabled('Refuse'), false)
  assert.equal((await texts(ui, '.task-notice-more'))[0], '2 other tasks wait')
  assert.equal(await ui.evaluate("document.querySelector('.task-notice').dataset.kind"), 'waiting')
  await ui.capture('tasks-notice')
  await ui.wait("document.querySelector('.task-notice-actions .primary').disabled===false")
  await ui.click('.task-notice-actions button', 'Allow once')
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args), [['codex:t1', 'r1', 'allow-once']])
  await emit(waiting({ id: 'codex:t1#r2', requestId: 'r2' }))
  assert.equal(await disabled('Allow once'), true, 'the next notice is held for a moment as well')
  // The buttons are free again once the page has taken the new notice in.
  await ui.wait("[...document.querySelectorAll('.task-notice-actions button')].find(b=>b.textContent==='Refuse').disabled===false")
  await ui.click('.task-notice-actions button', 'Refuse')
  assert.deepEqual((await ui.calls('answerRunnerTask')).map(call => call.args[2]), ['allow-once', 'refuse'])

  // A command that looks dangerous, or does not fit, is allowed in the window and nowhere else.
  await emit(waiting({ id: 'claude:s1#r3', key: 'claude:s1', requestId: 'r3', detail: 'rm -rf build', danger: 'It deletes files or folders for good.', canAllow: false }))
  await ui.wait("!!document.querySelector('.task-notice-danger')")
  assert.deepEqual(await buttons(), ['Refuse', 'Open'])
  assert.equal(await ui.evaluate("document.querySelector('.task-notice-danger .task-danger').textContent"), 'Dangerous')
  assert.ok((await texts(ui, '.task-notice-danger'))[0].includes('It deletes files or folders for good.'))
  assert.ok((await texts(ui, '.task-notice-note'))[0].includes('allowed in the Togle window'))
  await ui.capture('tasks-notice-danger')
  await emit(waiting({ id: 'claude:s1#r4', key: 'claude:s1', requestId: 'r4', detail: 'npm run build -- --flag --flag…', canAllow: false }))
  await ui.wait("!document.querySelector('.task-notice-danger')")
  assert.deepEqual(await buttons(), ['Refuse', 'Open'])
  assert.ok((await texts(ui, '.task-notice-note'))[0].startsWith('Not all of it fits here'))

  // A question can only be answered in the window.
  await emit(waiting({ id: 'claude:s1#r5', key: 'claude:s1', requestId: 'r5', says: 'asks', detail: 'Which pricing table?', detailKind: 'question', canRefuse: false, canAllow: false }))
  await ui.wait("document.querySelector('.task-notice-detail')?.textContent==='Which pricing table?'")
  assert.deepEqual(await buttons(), ['Open'])
  assert.equal((await ui.calls('answerRunnerTask')).length, 2, 'nothing was answered by showing it')
  await ui.click('.task-notice-actions button', 'Open')
  assert.deepEqual((await ui.calls('openTaskFromNotice')).map(call => call.args), [['claude:s1']])

  // A task that finished is only news: it can be opened or closed.
  await emit({ id: 'codex:t1#end1', kind: 'done', key: 'codex:t1', title: 'Add the status column', where: 'Codex · api-server', says: 'finished', detail: 'Added the column and ran the tests.', detailKind: 'words', canRefuse: false, canAllow: false, others: 0 })
  await ui.wait("document.querySelector('.task-notice')?.dataset.kind==='done'")
  assert.deepEqual(await buttons(), ['Open'])
  assert.equal((await texts(ui, '.task-notice-says'))[0], 'Codex · api-server finished')
  await ui.capture('tasks-notice-done')
  await ui.click('.task-notice-head button', 'Close notice')
  assert.deepEqual((await ui.calls('dismissTaskNotice')).map(call => call.args), [['codex:t1#end1']])

  // A refused answer says why, and the buttons come back.
  await emit(waiting({ id: 'codex:gone#r1', key: 'codex:gone', title: 'Gone' }))
  await ui.wait("document.querySelector('.task-notice-head strong')?.textContent==='Gone'")
  await ui.click('.task-notice-actions button', 'Refuse')
  await ui.wait("!!document.querySelector('.task-notice-error')")
  assert.equal((await texts(ui, '.task-notice-error'))[0], 'That task is gone.')
  assert.equal(await disabled('Refuse'), false, 'it can be tried again')

  // Told to show nothing, it shows nothing; and it always says how tall it is.
  await emit(null)
  await ui.wait("!document.querySelector('.task-notice')")
  const heights = (await ui.calls('sizeTaskNotice')).map(call => call.args[0])
  assert.ok(heights.length > 3 && heights.every(height => Number.isFinite(height) && height > 60 && height < 480), 'sizes: ' + heights)
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
    await checkNotice(T, agent)
    await checkTodo(T, agent)
    await checkChanges(T, agent)
    await checkOutside(T, agent)
    await checkOutsideAsk(T, agent)
    await checkTaskBox(T, agent)
    await checkAgentSettings(T, agent)
    console.log('Tasks screen: list, requests, danger mark, stop and second press, reply, continue, take over, new task, narrow layout, the question before quitting, the notice, the to-do list, the changes, Claude Code in a terminal, the task box and the settings for coding agents passed')
    clearTimeout(timeout)
    app.quit()
  } catch (error) {
    console.error(error.stack || error)
    clearTimeout(timeout)
    app.exit(1)
  }
})
