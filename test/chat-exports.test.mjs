// Their chats on claude.ai and ChatGPT, from the export of them they download: told apart from other zips, listed among
// their work sessions by account (the newest export of each), read as a document (the branch each chat ended on, what
// they attached and the AI wrote, without what's hidden or secret), given to an agent, brought up to date from a newer
// export, and found when they ask for one in words.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { backend, call, say, wait, workDir } from './helpers.mjs'

const dir = workDir('chat-exports')
// Their home folder and Downloads, here: never the real ones of whoever runs the tests.
const home = path.join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude')
process.env.CODEX_HOME = path.join(home, '.codex')
const downloads = path.join(home, 'Downloads')
const list = path.join(dir, 'chat-exports.json')

const { AgentStore, ChatGPTProvider, addExport, entryStream, exportAt, findSessions, readChat, sessionHomes, sessionInfo, setChatExports, train, zipEntries } =
  await import('./.build/togle.mjs')

const write = (file, text, at) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (at) utimesSync(file, new Date(at), new Date(at))
  return file
}
/** A zip of these files (JSON for objects), packed or (named in `stored`) not, made at `at`. */
async function zipOf(file, files, at, { stored = [], comment } = {}) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files))
    zip.file(name, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content), stored.includes(name) ? { compression: 'STORE' } : {})
  return write(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment }), at)
}

// ---- ChatGPT: a chat is a tree of messages, each edit or retry a branch ----

const seconds = (iso) => Date.parse(iso) / 1000
const node = (id, parent, children, message) => ({ id, parent, children, message: message && { id, metadata: {}, recipient: 'all', ...message } })
const text = (role, words, at) => ({ author: { role }, create_time: seconds(at), content: { content_type: 'text', parts: [words] } })

const GPT_DEPLOY = '6720b1aa-0000-8000-8000-00000000d001'
const GPT_TRIP = '6720b1aa-0000-8000-8000-00000000d002'
const GPT_SSO = '6720b1aa-0000-8000-8000-00000000d003'

/** The deploy chat as an export has it, with what was said in it since (`more`, in a newer export). */
function deployChat(more = []) {
  const mapping = {
    root: node('root', null, ['sys'], null),
    sys: node('sys', 'root', ['ctx'], { ...text('system', '', '2026-10-23T09:00:00Z'), metadata: { is_visually_hidden_from_conversation: true } }),
    // Their custom instructions: not said in the chat.
    ctx: node('ctx', 'sys', ['n1'], { author: { role: 'user' }, content: { content_type: 'user_editable_context', user_profile: 'CUSTOM INSTRUCTIONS: I live in Belgrade' } }),
    n1: node('n1', 'ctx', ['n2b', 'n2'], text('user', 'Checklist to deploy the billing service on Friday?', '2026-10-23T09:00:00Z')),
    // A reply it was asked to try again: not the branch the chat went on.
    n2b: node('n2b', 'n1', [], text('assistant', 'OLD TRY: deploy on Monday.', '2026-10-23T09:00:20Z')),
    n2: node('n2', 'n1', ['n3'], {
      author: { role: 'assistant' },
      create_time: seconds('2026-10-23T09:00:40Z'),
      recipient: 'web.run',
      content: { content_type: 'code', text: '{"search_query":[{"q":"billing deploy freeze policy"}]}' }
    }),
    n3: node('n3', 'n2', ['n4'], { author: { role: 'tool', name: 'web.run' }, create_time: seconds('2026-10-23T09:00:45Z'), content: { content_type: 'text', parts: ['TOOL OUTPUT NOISE'] } }),
    n4: node('n4', 'n3', ['n5'], { author: { role: 'assistant' }, create_time: seconds('2026-10-23T09:00:50Z'), content: { content_type: 'thoughts', thoughts: [{ summary: 'HIDDEN THINKING' }] } }),
    n5: node('n5', 'n4', ['n6'], text('assistant', 'The freeze starts Friday 18:00, so deploy by 15:00.', '2026-10-23T09:01:00Z')),
    // Said in a voice chat, with a picture and a file.
    n6: node('n6', 'n5', ['n7'], {
      author: { role: 'user' },
      create_time: seconds('2026-10-23T09:05:00Z'),
      content: {
        content_type: 'multimodal_text',
        parts: [
          { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-abc' },
          { content_type: 'audio_transcription', text: 'Also ping the on-call, Dana.' }
        ]
      },
      metadata: { attachments: [{ name: 'runbook.pdf', mime_type: 'application/pdf' }] }
    }),
    n7: node('n7', 'n6', ['n8'], {
      author: { role: 'assistant' },
      create_time: seconds('2026-10-23T09:05:30Z'),
      recipient: 'canmore.create_textdoc',
      content: { content_type: 'code', text: JSON.stringify({ name: 'Deploy plan', type: 'document', content: '1. Tag the release. 2. Deploy by 15:00. 3. Tell Dana.' }) }
    }),
    // What it noted in its memory of them.
    n8: node('n8', 'n7', ['n9'], { author: { role: 'assistant' }, create_time: seconds('2026-10-23T09:05:40Z'), recipient: 'bio', content: { content_type: 'code', text: 'MEMORY NOTE: deploys on Fridays' } }),
    n9: node('n9', 'n8', [], text('assistant', 'Plan written; Dana is on call. The deploy key is password=hunter2hunter2.', '2026-10-23T09:06:00Z'))
  }
  let last = 'n9'
  for (const [i, [role, words, at]] of more.entries()) {
    const id = `m${i}`
    mapping[last].children = [id]
    mapping[id] = node(id, last, [], text(role, words, at))
    last = id
  }
  const updated = more.length ? more.at(-1)[2] : '2026-10-23T09:06:00Z'
  return { title: 'Deploy checklist', create_time: seconds('2026-10-23T09:00:00Z'), update_time: seconds(updated), mapping, current_node: last, conversation_id: GPT_DEPLOY, id: GPT_DEPLOY }
}
const tripChat = {
  title: 'New chat',
  create_time: seconds('2026-10-10T18:00:00Z'),
  update_time: seconds('2026-10-10T18:01:00Z'),
  mapping: {
    r: node('r', null, ['u'], null),
    u: node('u', 'r', ['a'], text('user', 'Plan a weekend in Lisbon for October.', '2026-10-10T18:00:00Z')),
    a: node('a', 'u', [], text('assistant', 'Day 1: Alfama and the castle.', '2026-10-10T18:01:00Z'))
  },
  current_node: 'a',
  id: GPT_TRIP
}
const personal = { id: 'user-personal', email: 'me@personal.example', chatgpt_plus_user: true, phone_number: '+10000000000' }

// The export they downloaded (a large one comes in numbered parts), and an older one of the same account.
const personalZip = await zipOf(
  path.join(downloads, 'a3f9c0de-2026-10-24-09-00-00.zip'),
  {
    'conversations-000.json': [deployChat()],
    'conversations-001.json': [tripChat],
    'user.json': personal,
    'chat.html': '<html>chats</html>',
    'file-abc.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  },
  '2026-10-24T09:00:00Z',
  { stored: ['chat.html', 'file-abc.png'], comment: 'an export' }
)
const oldChat = deployChat()
oldChat.mapping.n1.children = ['n2b']
oldChat.current_node = 'n2b'
await zipOf(path.join(downloads, 'old-export.zip'), { 'conversations.json': [oldChat], 'user.json': personal }, '2026-10-01T09:00:00Z')
// Another account's, unpacked into a folder.
const acmeFolder = path.join(downloads, 'chatgpt-acme')
write(path.join(acmeFolder, 'user.json'), JSON.stringify({ id: 'user-acme', email: 'me@acme.example' }))
write(
  path.join(acmeFolder, 'conversations.json'),
  JSON.stringify([
    {
      title: 'Acme SSO rollout',
      create_time: seconds('2026-10-22T09:00:00Z'),
      update_time: seconds('2026-10-22T10:00:00Z'),
      mapping: {
        r: node('r', null, ['u'], null),
        u: node('u', 'r', ['a'], text('user', 'Which IdP does Acme use for the SSO rollout?', '2026-10-22T09:00:00Z')),
        a: node('a', 'u', [], text('assistant', 'Okta, with SCIM for the user list.', '2026-10-22T10:00:00Z'))
      },
      current_node: 'a',
      id: GPT_SSO
    }
  ]),
  '2026-10-22T11:00:00Z'
)

// ---- claude.ai: every try of a chat is kept, each message saying the one it follows ----

const CLAUDE_PRICING = 'c1a0de00-0000-4000-8000-000000000001'
const ROOT = '00000000-0000-4000-8000-000000000000'
const claudeSaid = (uuid, sender, parent, at, content, more = {}) => ({ uuid, sender, parent_message_uuid: parent, created_at: at, updated_at: at, text: '', content, attachments: [], files: [], ...more })
const claudeZip = await zipOf(
  path.join(dir, 'elsewhere', 'data-2026-10-25-batch-0000.zip'),
  {
    'data-2026-10-25-batch-0000/users.json': [{ uuid: 'acct-claude', full_name: 'Me', email_address: 'me@personal.example' }],
    'data-2026-10-25-batch-0000/conversations.json': [
      {
        uuid: CLAUDE_PRICING,
        name: 'Acme pricing proposal',
        created_at: '2026-10-20T09:00:00.112233Z',
        updated_at: '2026-10-21T16:00:00.445566Z',
        account: { uuid: 'acct-claude' },
        chat_messages: [
          claudeSaid('m1', 'human', ROOT, '2026-10-20T09:00:00Z', [{ type: 'text', text: 'Draft pricing for Acme: 40 seats.' }], {
            attachments: [{ file_name: 'acme-notes.txt', file_type: 'txt', file_size: 80, extracted_content: 'Acme wants SSO. Budget 30k. api_key=sk_live_abcdefghijklmnop1234' }],
            files: [{ file_name: 'whiteboard.png' }]
          }),
          claudeSaid('m2', 'assistant', 'm1', '2026-10-20T09:01:00Z', [
            { type: 'thinking', thinking: 'secret reasoning' },
            { type: 'tool_use', name: 'web_search', input: { query: 'Acme Corp seat pricing' } },
            { type: 'tool_result', name: 'web_search', content: [{ type: 'text', text: 'SEARCH RESULT NOISE' }] },
            { type: 'text', text: 'Here is a draft: $50 per seat.' },
            { type: 'tool_use', name: 'artifacts', input: { command: 'create', title: 'Acme pricing one-pager', content: 'Seats: 40 at $50. Total $2,000 a month.' } }
          ]),
          // An earlier try of that reply.
          claudeSaid('m2-old', 'assistant', 'm1', '2026-10-20T09:00:30Z', [{ type: 'text', text: 'OLD BRANCH: $80 per seat.' }]),
          claudeSaid('m3', 'human', 'm2', '2026-10-21T15:59:00Z', [{ type: 'text', text: 'They pushed back. Go to $45 and add SSO.' }]),
          claudeSaid('m4', 'assistant', 'm3', '2026-10-21T16:00:00Z', [
            { type: 'tool_use', name: 'Atlassian:getJiraIssue', input: { key: 'ACME-12' } },
            { type: 'tool_result', name: 'Atlassian:getJiraIssue', content: [{ type: 'text', text: 'ACME-12: SSO via Okta, due Nov 15.' }] },
            { type: 'text', text: 'Done: $45 per seat with SSO; ACME-12 tracks the Okta work.' }
          ])
        ]
      },
      // Opened and left: nothing was said in it.
      { uuid: 'c1a0de00-0000-4000-8000-000000000002', name: '', created_at: '2026-10-19T09:00:00Z', updated_at: '2026-10-19T09:00:00Z', chat_messages: [] }
    ]
  },
  '2026-10-25T09:00:00Z'
)

// ---- What else is in Downloads, and one of their sessions in Claude Code ----

const photos = await zipOf(path.join(downloads, 'holiday-photos.zip'), { 'IMG_0001.jpg': Buffer.from([1, 2, 3]), 'notes.txt': 'beach' })
const otherApp = await zipOf(path.join(downloads, 'other-app.zip'), { 'conversations.json': { version: 1 } })
const notChats = await zipOf(path.join(downloads, 'not-chats.zip'), { 'conversations.json': [{ foo: 1 }] })
const broken = write(path.join(downloads, 'broken.zip'), 'PK\x03\x04 not a whole zip')
const notes = write(path.join(downloads, 'notes.json'), '{"a":1}')
const project = path.join(downloads, 'project')
write(path.join(project, 'readme.md'), '# A project')
const SHOP = 'aaaa0000-0000-4000-8000-000000000001'
write(
  path.join(home, '.claude', 'projects', 'C--work-shop', `${SHOP}.jsonl`),
  [
    { type: 'user', message: { role: 'user', content: 'The checkout crashes on Safari.' }, cwd: 'C:\\work\\shop', sessionId: SHOP, timestamp: '2026-10-22T12:00:00Z', origin: { kind: 'human' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] }, cwd: 'C:\\work\\shop', sessionId: SHOP, timestamp: '2026-10-22T12:00:00Z' },
    { type: 'ai-title', aiTitle: 'Checkout crash on Safari', sessionId: SHOP }
  ]
    .map((r) => JSON.stringify(r))
    .join('\n'),
  '2026-10-22T12:00:00Z'
)

setChatExports({ list, downloads })

// What a chat is about, by what was asked in it, as studying it says.
const store = new AgentStore(async (system, user) => `About: ${/Lisbon/.test(user) ? 'A weekend in Lisbon' : 'Deploying billing'}\n- Status as of Fri, Oct 23: planned`)
await store.load()
const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
const talk = async (agentId, message, rounds) => {
  const requests = backend(rounds)
  const changes = []
  await train(store, provider, agentId, [], message, new AbortController().signal, { onDelta() {}, onChange: (c) => changes.push(c) })
  const outputs = requests
    .at(-1)
    .input.filter((i) => i.type === 'function_call_output')
    .map((i) => i.output)
  return { outputs, changes }
}
async function until(check, what) {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await wait(10)
  }
  assert.fail(`never: ${what}`)
}

test('an export of their chats is told from other zips and files, and which one it is', async () => {
  const gpt = await exportAt(personalZip)
  assert.equal(gpt.tool, 'chatgpt')
  assert.equal(gpt.account, 'user-personal')
  assert.equal(gpt.email, 'me@personal.example')
  assert.deepEqual(
    gpt.parts.map((p) => p.name),
    ['conversations-000.json', 'conversations-001.json'],
    'a large one comes in parts'
  )
  const claude = await exportAt(claudeZip)
  assert.equal(claude.tool, 'claude-ai')
  assert.equal(claude.account, 'acct-claude')
  assert.deepEqual(
    claude.parts.map((p) => p.name),
    ['data-2026-10-25-batch-0000/conversations.json']
  )
  const acme = await exportAt(acmeFolder)
  assert.equal(acme.tool, 'chatgpt')
  assert.equal(acme.email, 'me@acme.example')
  assert.equal((await exportAt(path.join(acmeFolder, 'conversations.json'))).account, 'user-acme', 'its file alone, with who it is of beside it')
  for (const other of [photos, otherApp, notChats, broken, notes, project, path.join(dir, 'missing.zip')]) assert.equal(await exportAt(other), null, other)
})

test('a zip is read from its list of files: a part stored as it is, one with a comment; one cut short is no zip', async () => {
  const entries = await zipEntries(personalZip)
  assert.deepEqual(entries.map((e) => e.name).sort(), ['chat.html', 'conversations-000.json', 'conversations-001.json', 'file-abc.png', 'user.json'])
  const html = entries.find((e) => e.name === 'chat.html')
  assert.equal(html.method, 0)
  let read = ''
  for await (const chunk of await entryStream(personalZip, html)) read += chunk
  assert.equal(read, '<html>chats</html>')
  const cut = write(path.join(dir, 'cut.zip'), readFileSync(personalZip).subarray(0, 200))
  assert.equal(await zipEntries(cut), null)
})

test('their accounts on ChatGPT, from the newest export of each, and their chats among their work sessions', async () => {
  const homes = await sessionHomes()
  assert.deepEqual(
    homes.map((h) => [h.tool, h.name]),
    [
      ['claude-code', 'Claude Code'],
      ['chatgpt', 'ChatGPT (me@personal.example)'],
      ['chatgpt', 'ChatGPT (me@acme.example)']
    ],
    'two accounts on ChatGPT, told apart by their email'
  )
  assert.equal(homes[1].from, personalZip, 'the newest export of that account, not the older one')
  assert.equal(homes[2].from, acmeFolder)

  const all = await findSessions()
  assert.deepEqual(
    all.map((s) => [s.title, s.home]),
    [
      ['Deploy checklist', 'ChatGPT (me@personal.example)'],
      ['Checkout crash on Safari', 'Claude Code'],
      ['Acme SSO rollout', 'ChatGPT (me@acme.example)'],
      ['Plan a weekend in Lisbon for October.', 'ChatGPT (me@personal.example)']
    ],
    'newest first, sessions and chats together'
  )
  const [deploy] = all
  assert.equal(deploy.file, `https://chatgpt.com/c/${GPT_DEPLOY}`)
  assert.equal(deploy.tool, 'chatgpt')
  assert.equal(deploy.named, true, 'named in their list of chats')
  assert.equal(deploy.first, 'Checklist to deploy the billing service on Friday?')
  assert.equal(deploy.last, 'Also ping the on-call, Dana. [attached runbook.pdf]', 'as the newest export has it')
  assert.equal(all[3].named, undefined, 'one not named yet is called by what was asked')
  assert.deepEqual(
    (await findSessions('lisbon')).map((s) => s.id),
    [GPT_TRIP]
  )
  assert.deepEqual(
    (await findSessions('acme.example')).map((s) => s.id),
    [GPT_SSO],
    'by the account it is from'
  )
  assert.deepEqual(
    (await findSessions('', 30, [homes[2].dir])).map((s) => s.id),
    [GPT_SSO]
  )
  assert.equal((await sessionInfo(deploy.file)).home, 'ChatGPT (me@personal.example)')
  assert.equal(await sessionInfo('https://chatgpt.com/c/6720b1aa-0000-8000-8000-0000000000ff'), null, 'one no export has')
})

test('a chat as a document: the branch it ended on, what was searched, said and written, without what is hidden', async () => {
  const text = await readChat(`https://chatgpt.com/c/${GPT_DEPLOY}`)
  assert.match(text, /^# Deploy checklist — a chat on ChatGPT\n\nA chat on ChatGPT with ChatGPT, an AI assistant, on \w{3}, Oct 23, 2026\./)
  assert.match(text, /Me \(\d\d:\d\d\): Checklist to deploy the billing service on Friday\?/)
  assert.match(text, /\(searched the web: billing deploy freeze policy\)\n\nChatGPT: The freeze starts Friday 18:00, so deploy by 15:00\./)
  assert.match(text, /Me \(\d\d:\d\d\): Also ping the on-call, Dana\. \[attached runbook\.pdf\] \[a picture\]/)
  assert.match(text, /ChatGPT wrote "Deploy plan": 1\. Tag the release\. 2\. Deploy by 15:00\. 3\. Tell Dana\./)
  assert.match(text, /password=\[secret removed\]/)
  for (const hidden of ['OLD TRY', 'TOOL OUTPUT NOISE', 'HIDDEN THINKING', 'CUSTOM INSTRUCTIONS', 'MEMORY NOTE', 'hunter2']) assert.ok(!text.includes(hidden), hidden)
})

test('an export they give from elsewhere is kept track of, and its chats read the same', async () => {
  assert.deepEqual(await addExport(claudeZip), { home: 'claude.ai', chats: 1, newest: Date.parse('2026-10-21T16:00:00.445566Z') })
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')).files, [claudeZip])
  assert.equal(await addExport(photos), null, 'not an export')
  // Known again when Togle starts again.
  setChatExports({ list, downloads })
  assert.deepEqual(
    (await sessionHomes()).map((h) => h.name),
    ['Claude Code', 'claude.ai', 'ChatGPT (me@personal.example)', 'ChatGPT (me@acme.example)']
  )
  const text = await readChat(`https://claude.ai/chat/${CLAUDE_PRICING}`)
  assert.match(text, /^# Acme pricing proposal — a chat on claude\.ai\n/)
  assert.match(text, /Me \(\d\d:\d\d\): Draft pricing for Acme: 40 seats\. \[a picture\]\n\nWhat I attached \(acme-notes\.txt\): Acme wants SSO\. Budget 30k\. api_key=\[secret removed\]/)
  assert.match(text, /\(searched the web: Acme Corp seat pricing\)\n\nClaude: Here is a draft: \$50 per seat\.\n\nClaude wrote "Acme pricing one-pager": Seats: 40 at \$50\./)
  assert.match(text, /What Atlassian:getJiraIssue gave: ACME-12: SSO via Okta, due Nov 15\.\n\nClaude: Done: \$45 per seat with SSO/)
  for (const hidden of ['OLD BRANCH', 'secret reasoning', 'SEARCH RESULT NOISE', 'sk_live']) assert.ok(!text.includes(hidden), hidden)
})

test('a chat given to an agent keeps the name it has in their list, and a newer export brings it up to date', async () => {
  const agent = await store.create('general')
  const address = `https://chatgpt.com/c/${GPT_DEPLOY}`
  const docOf = (source) => store.get(agent.id).knowledge.find((d) => d.source === source)
  const { done, doc } = await store.addSession(agent.id, address)
  assert.equal(done, 'added')
  assert.equal(doc.kind, 'session')
  assert.equal(doc.name, 'Deploy checklist (ChatGPT chat)')
  await until(() => docOf(address)?.digest, 'studied')
  assert.equal(docOf(address).name, 'Deploy checklist (ChatGPT chat)')
  assert.equal(await store.refreshSessions(agent.id), 0, 'nothing newer')
  assert.equal((await store.addSession(agent.id, address)).done, 'unchanged')

  // One with no name yet is named by what it's about, once studied.
  const trip = `https://chatgpt.com/c/${GPT_TRIP}`
  assert.equal((await store.addSession(agent.id, trip)).doc.name, 'Plan a weekend in Lisbon for October. (ChatGPT chat)')
  await until(() => docOf(trip)?.name === 'A weekend in Lisbon (ChatGPT chat)', 'named by what it is about')

  // Written in since, and exported again: the newer export is read.
  await zipOf(
    path.join(downloads, 'b7e1d2aa-2026-10-26-10-00-00.zip'),
    {
      'conversations.json': [
        deployChat([
          ['user', 'Moved to Thursday instead.', '2026-10-26T09:00:00Z'],
          ['assistant', 'Thursday 15:00 then.', '2026-10-26T09:00:30Z']
        ]),
        tripChat
      ],
      'user.json': personal
    },
    '2026-10-26T10:00:00Z'
  )
  setChatExports({ list, downloads })
  assert.equal(await store.refreshSessions(agent.id), 1, 'the one written in since')
  const text = readFileSync(path.join(dir, 'agents', agent.id, `${docOf(address).id}.txt`), 'utf8')
  assert.match(text, /Me \(\d\d:\d\d\): Moved to Thursday instead\.\n\nChatGPT: Thursday 15:00 then\.$/)
  assert.equal(docOf(address).name, 'Deploy checklist (ChatGPT chat)')
})

test('asked for a chat in words, the agent finds it, in one account or all, and adds it', async () => {
  const agent = await store.create('general')
  const { outputs, changes } = await talk(agent.id, 'Add my ChatGPT chat about the Acme SSO rollout.', [
    call(1, 'find_work_sessions', { query: 'SSO rollout' }),
    call(2, 'find_work_sessions', { query: 'deploy', from: 'ChatGPT' }),
    call(3, 'find_work_sessions', { from: 'acme' }),
    call(4, 'add_work_session', { id: GPT_SSO }),
    say('Added it.')
  ])
  assert.match(outputs[0], /^Looked in all of them: Claude Code, claude\.ai, ChatGPT \(me@personal\.example\), ChatGPT \(me@acme\.example\)\.\n/)
  assert.match(outputs[0], new RegExp(`\\n- id ${GPT_SSO}: "Acme SSO rollout" \\(ChatGPT \\(me@acme\\.example\\)\\), last worked on `))
  assert.equal(outputs[1], '"ChatGPT" could be ChatGPT (me@personal.example), ChatGPT (me@acme.example): say which.')
  assert.match(outputs[2], /^Looked in ChatGPT \(me@acme\.example\)\. Also on this PC: Claude Code, claude\.ai, ChatGPT \(me@personal\.example\)\.\n- id /)
  assert.match(outputs[3], /^Added: "Acme SSO rollout \(ChatGPT chat\)"/)
  assert.deepEqual(changes, ['Added to Knowledge: Acme SSO rollout (ChatGPT chat)'])

  // An account on the web as its own.
  const own = await talk(agent.id, 'This agent is for Acme: only my Acme ChatGPT.', [call(1, 'set_session_sources', { sources: ['acme'] }), call(2, 'find_work_sessions', {}), say('Done.')])
  assert.match(own.outputs[0], /^Work sessions from: ChatGPT \(me@acme\.example\)\. find_work_sessions looks only there now/)
  assert.match(own.outputs[1], /^Looked in this agent's own: ChatGPT \(me@acme\.example\)\./)
  assert.doesNotMatch(own.outputs[1], /Deploy checklist|Checkout crash/)
})

test('with no export, a chat on the web they ask for is said to come from one', async () => {
  setChatExports({})
  try {
    const agent = await store.create('general')
    const { outputs } = await talk(agent.id, 'Add my ChatGPT chat about pricing.', [
      call(1, 'find_work_sessions', { query: 'pricing' }),
      call(2, 'find_work_sessions', { query: 'pricing', from: 'ChatGPT' }),
      say('Export it first.')
    ])
    assert.equal(
      outputs[0],
      'No work session matches "pricing". Try other words, or none for the latest. No export of their chats on claude.ai or ChatGPT is on this PC yet: those come in from one.'
    )
    assert.equal(outputs[1], "There's no export of their ChatGPT chats on this PC yet: those come in from one. There are: Claude Code.")
  } finally {
    setChatExports({ list, downloads })
  }
})

test('an export they gave that is gone is let go of', async () => {
  rmSync(claudeZip)
  assert.ok(!(await sessionHomes()).some((h) => h.tool === 'claude-ai'))
  assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')).files, [])
})
