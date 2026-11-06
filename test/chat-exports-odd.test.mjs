// Exports of their chats as they turn up on a real PC: the list of the ones they gave cut short by a power cut, a big
// claude.ai export in batches, one chat in it that can't be read, a key in a chat's first line, an older export left
// after the newer one is deleted, one on a drive that's unplugged, one unpacked a folder down.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { wait, workDir } from './helpers.mjs'

const dir = workDir('chat-exports-odd')
const home = path.join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude')
process.env.CODEX_HOME = path.join(home, '.codex')
const downloads = path.join(home, 'Downloads')
const list = path.join(dir, 'chat-exports.json')

const { AgentStore, addExport, currentExports, findSessions, readChat, sessionHomes, setChatExports } = await import('./.build/togle.mjs')

const write = (file, text, at) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (at) utimesSync(file, new Date(at), new Date(at))
  return file
}
async function zipOf(file, files, at) {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, typeof content === 'string' ? content : JSON.stringify(content))
  return write(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), at)
}
const ROOT = '00000000-0000-4000-8000-000000000000'
/** A claude.ai chat of one question and its answer. */
const claudeChat = (uuid, name, asked, answer, at) => ({
  uuid,
  name,
  created_at: at,
  updated_at: at,
  chat_messages: [
    { uuid: `${uuid}-1`, sender: 'human', parent_message_uuid: ROOT, created_at: at, content: [{ type: 'text', text: asked }], attachments: [], files: [] },
    { uuid: `${uuid}-2`, sender: 'assistant', parent_message_uuid: `${uuid}-1`, created_at: at, content: [{ type: 'text', text: answer }], attachments: [], files: [] }
  ]
})
/** A ChatGPT chat of one question and its answer, written as its export writes it. */
const gptChat = (id, title, asked, answer, at) => {
  const t = Date.parse(at) / 1000
  const say = (role, words) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [words] }, metadata: {}, recipient: 'all' })
  return {
    conversation_id: id,
    title,
    create_time: t,
    update_time: t,
    current_node: 'a',
    mapping: {
      root: { id: 'root', parent: null, children: ['q'], message: null },
      q: { id: 'q', parent: 'root', children: ['a'], message: { id: 'q', ...say('user', asked) } },
      a: { id: 'a', parent: 'q', children: [], message: { id: 'a', ...say('assistant', answer) } }
    }
  }
}
// Nothing of theirs in Claude Code: just an empty folder of it, so the list is of their chats.
mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true })

test("a list of the exports they gave that can't be read (cut short, zeros) doesn't take their work sessions down", async () => {
  write(list, '\0\0\0\0')
  setChatExports({ list, downloads })
  assert.deepEqual(
    (await sessionHomes()).map((h) => h.name),
    ['Claude Code']
  )
  assert.deepEqual(await findSessions(''), [])
})

test("a big export from claude.ai in batches is one export, and an unreadable chat in one doesn't lose the others", async () => {
  rmSync(list, { force: true })
  setChatExports({ list, downloads })
  const at = '2026-10-25T09:00:00Z'
  await zipOf(
    path.join(downloads, 'data-2026-10-25-batch-0000.zip'),
    {
      'users.json': [{ uuid: 'acct-claude', email_address: 'me@personal.example' }],
      'conversations.json': [claudeChat('c1a0de00-0000-4000-8000-000000000001', 'Acme pricing', 'Draft pricing for Acme.', '$45 per seat with SSO.', at)]
    },
    at
  )
  // The second batch: no account file of its own, and a chat in it that isn't JSON (a NaN written in it).
  const good = JSON.stringify(claudeChat('c1a0de00-0000-4000-8000-000000000002', 'Lisbon trip', 'A weekend in Lisbon?', 'Alfama, then Belém.', at))
  const zip = new JSZip()
  zip.file('conversations.json', `[{"uuid":"c1a0de00-0000-4000-8000-000000000003","name":"Broken","n":NaN,"chat_messages":[]},${good}]`)
  write(path.join(downloads, 'data-2026-10-25-batch-0001.zip'), await zip.generateAsync({ type: 'nodebuffer' }), at)
  const homes = (await sessionHomes()).filter((h) => h.tool === 'claude-ai')
  assert.deepEqual(
    homes.map((h) => h.name),
    ['claude.ai'],
    'one account, not one for each batch'
  )
  assert.deepEqual((await findSessions('')).map((s) => s.title).sort(), ['Acme pricing', 'Lisbon trip'])
  assert.match(await readChat('https://claude.ai/chat/c1a0de00-0000-4000-8000-000000000002'), /Alfama, then Belém\./)
})

test("a key in a chat's first line is out of its title and of what's listed of it", async () => {
  const at = '2026-10-24T09:00:00Z'
  const zip = await zipOf(
    path.join(dir, 'given', 'chatgpt-export.zip'),
    {
      'user.json': { id: 'user-gpt', email: 'me@personal.example' },
      'conversations.json': [gptChat('6720b1aa-0000-8000-8000-00000000d001', '', 'Why does sk-proj-abcdefghijklmnopqrstuvwxyz0123 get a 401?', 'It was revoked.', at)]
    },
    at
  )
  await addExport(zip)
  const [chat] = (await findSessions('401')).filter((s) => s.tool === 'chatgpt')
  assert.equal(chat.title, 'Why does [secret removed] get a 401?')
  assert.doesNotMatch(JSON.stringify(chat), /sk-proj-/)
})

test('a chat read from a newer export is never read back from an older one left behind', async () => {
  const older = '2026-10-01T09:00:00Z'
  const newer = '2026-10-20T09:00:00Z'
  const id = '6720b1aa-0000-8000-8000-00000000e001'
  const exports = path.join(dir, 'exports')
  const oldZip = await zipOf(
    path.join(exports, 'old.zip'),
    { 'user.json': { id: 'user-deals' }, 'conversations.json': [gptChat(id, 'Globex deal', 'What can we offer Globex?', 'Start at 5% off.', older)] },
    older
  )
  const newZip = await zipOf(
    path.join(exports, 'new.zip'),
    { 'user.json': { id: 'user-deals' }, 'conversations.json': [gptChat(id, 'Globex deal', 'What can we offer Globex?', 'FINAL: 10% off for two years.', newer)] },
    newer
  )
  await addExport(oldZip)
  await addExport(newZip)
  const store = new AgentStore(async () => 'About: the Globex deal\n- Status as of Oct 20: 10% off')
  await store.load()
  const agent = await store.create('general')
  const address = `https://chatgpt.com/c/${id}`
  await store.addSession(agent.id, address)
  const text = () => {
    const doc = store.list().find((a) => a.id === agent.id).knowledge.find((d) => d.kind === 'session')
    return readFileSync(path.join(process.env.TOGLE_TEST_USER_DATA, 'agents', agent.id, `${doc.id}.txt`), 'utf8')
  }
  assert.match(text(), /FINAL: 10% off/)
  // The newer one deleted: the older one is the newest there is.
  rmSync(newZip)
  assert.equal(await store.refreshSessions(agent.id), 0)
  assert.equal((await store.addSession(agent.id, address)).done, 'unchanged')
  assert.equal(store.list().find((a) => a.id === agent.id).knowledge.length, 1)
  assert.match(text(), /FINAL: 10% off/)
})

test('an export they gave on a drive that is out for now is kept; one deleted from its folder is let go of', async () => {
  const usb = path.join(dir, 'usb')
  const zip = await zipOf(
    path.join(usb, 'chats.zip'),
    { 'user.json': { id: 'user-usb' }, 'conversations.json': [gptChat('6720b1aa-0000-8000-8000-00000000f001', 'Offsite', 'Offsite agenda?', 'Day one: strategy.', '2026-10-22T09:00:00Z')] },
    '2026-10-22T09:00:00Z'
  )
  await addExport(zip)
  const given = () => JSON.parse(readFileSync(list, 'utf8')).files
  renameSync(usb, `${usb}-out`)
  await currentExports()
  assert.ok(given().includes(zip), 'unplugged, it stays')
  renameSync(`${usb}-out`, usb)
  assert.ok((await currentExports()).some((ex) => ex.file === zip), 'and is read again once it is back')
  rmSync(zip)
  await currentExports()
  assert.ok(!given().includes(zip), 'deleted from its folder, it goes')
})

test('an export unpacked a folder down in Downloads (Extract All) is found', async () => {
  const at = '2026-10-26T09:00:00Z'
  const inner = path.join(downloads, 'data-2026-10-26', 'data-2026-10-26')
  write(path.join(inner, 'users.json'), JSON.stringify([{ uuid: 'acct-work', email_address: 'me@work.example' }]), at)
  write(path.join(inner, 'conversations.json'), JSON.stringify([claudeChat('c1a0de00-0000-4000-8000-000000000009', 'Board deck', 'Outline the board deck.', 'Five slides.', at)]), at)
  // Downloads is looked through again after a while.
  await wait(10_500)
  assert.ok((await findSessions('board')).some((s) => s.title === 'Board deck'))
})
