// Weird files a user teaches an agent with, and code folders: each is read in a moment or refused with why, never
// freezing Togle (every import and search runs where calls run).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { workDir } from './helpers.mjs'

const work = workDir('imports')
const { AgentStore, CodeBase, SearchIndex, chunkText, extractText, globTest, listFolder, setCodePage, setReaderScript } = await import('./.build/togle.mjs')

const file = (name, content) => {
  const at = path.join(work, name)
  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, content)
  return at
}
const timed = async (work) => {
  const started = Date.now()
  const result = await work()
  return { result, ms: Date.now() - started }
}

test('a page of a million "<", or a comment or script never closed, reads in a moment', async () => {
  for (const [name, html] of [
    ['angles.html', `<p>Start</p>${'x<'.repeat(200_000)}`],
    ['comment.html', `<p>Start</p>${'<!--'.repeat(50_000)}`],
    ['script.html', `<p>Start</p>${'<script'.repeat(50_000)}`]
  ]) {
    const { result, ms } = await timed(() => extractText(file(name, html)))
    assert.ok(ms < 1500, `${name}: ${ms} ms`)
    assert.match(result, /Start/)
  }
  // A page as pages are still reads as before.
  const page = await extractText(file('page.html', '<h2>Plans</h2><ul><li>Growth: 39 &euro;</li><li>Scale &#8212; 35</li></ul><script>x()</script><p>Bye &#99999999;</p>'))
  assert.match(page, /## Plans\n\n- Growth: 39 &euro;\n- Scale — 35/)
  assert.match(page, new RegExp(`Bye ${String.fromCharCode(0xfffd)}`), 'a reference to no character is the replacement character')
})

test('a slide of paragraphs never closed reads in a moment', async () => {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', `<a:p><a:t>Agenda</a:t></a:p>${'<a:p>'.repeat(200_000)}`)
  const pptx = file('slides.pptx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const { result, ms } = await timed(() => extractText(pptx))
  assert.ok(ms < 2000, `${ms} ms`)
  assert.match(result, /Agenda/)
})

test('a Word file that says it unpacks to more than a document is refused before it is unpacked', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>')
  const docx = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  // Its directory says 100 MB, as a zip bomb's would.
  for (let i = 0; i < docx.length - 46; i++) if (docx.readUInt32LE(i) === 0x02014b50) docx.writeUInt32LE(100 * 1048576, i + 24)
  await assert.rejects(extractText(file('bomb.docx', docx)), /unpacks to more than Togle reads/)
})

test("text that isn't UTF-8 is read in the code page it was saved in, and UTF-16 without its mark is read too", async () => {
  /** Text as Windows saves it in a code page. */
  const saved = (text, page) => {
    const bytes = new Map([...new TextDecoder(page).decode(Uint8Array.from({ length: 256 }, (_, i) => i))].map((ch, i) => [ch, i]))
    return Buffer.from([...text].map((ch) => bytes.get(ch)))
  }
  const croatian = 'Osnovni;39 €;Plaća se mjesečno, otkaz bez naknade\nNapredni;79 €;Uključuje SAP integraciju i podršku'
  const russian = 'Оплата ежемесячная, отказ без комиссии.'
  const french = 'Vous pouvez arrêter à tout moment, ça coûte 39 € par mois.'
  // Nothing in it a Central European PC wouldn't read as Czech: what the page says it is decides.
  const italian = 'Così può funzionare perché più utenti lo usano.'
  try {
    setCodePage(1252) // An English PC
    // "Café" as Windows saves it (the é is the same in the Western and Central European code pages).
    assert.equal(await extractText(file('cafe.txt', Buffer.from([0x43, 0x61, 0x66, 0xe9]))), 'Café')
    assert.equal(await extractText(file('cijene.csv', saved(croatian, 'windows-1250'))), croatian)
    assert.equal(await extractText(file('ceny.txt', saved(russian, 'windows-1251'))), russian)
    setCodePage(1250) // A Croatian one
    assert.equal(await extractText(file('cijene2.csv', saved(croatian, 'windows-1250'))), croatian)
    assert.equal(await extractText(file('prix.txt', saved(french, 'windows-1252'))), french)
    const page = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>'), saved(italian, 'windows-1252'), Buffer.from('</p></body></html>')])
    assert.equal((await extractText(file('prezzi.html', page))).trim(), italian)
  } finally {
    setCodePage(undefined)
  }
  assert.equal(await extractText(file('wide.txt', Buffer.from('Support answers within a day.', 'utf16le'))), 'Support answers within a day.')
})

test('a document in Chinese, Japanese or Korean is found by the words asked about', () => {
  const docs = [
    '我们的企业版价格是每位用户每月三十九欧元，包含所有集成功能。退款政策：购买后三十天内可以全额退款。',
    '料金プランは月額三千九百円です。返金ポリシーは購入後三十日以内なら全額返金できます。',
    '가격은 사용자당 월 39유로입니다. 환불 정책은 구매 후 30일 이내 전액 환불입니다.',
    '我们支持SAP集成和Salesforce同步。',
    '会议室可以提前一周预订。'
  ].map((text, i) => ({ i, text }))
  const index = new SearchIndex(docs, (d) => d.text)
  assert.equal(index.search('退款政策是什么？', 1)[0]?.i, 0)
  assert.equal(index.search('返金はできますか', 1)[0]?.i, 1)
  assert.equal(index.search('환불 정책이 뭐예요?', 1)[0]?.i, 2)
  assert.equal(index.search('Salesforce', 1)[0]?.i, 3, 'a word in Latin letters within Chinese')
})

test('a long line goes into the search whole, in pieces, not cut after its start', () => {
  const words = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ')
  const chunks = chunkText({ docId: 'd', doc: 'Doc' }, words)
  assert.ok(chunks.length > 1)
  const joined = chunks.map((c) => c.text).join(' ')
  assert.match(joined, /word1499/)
  assert.ok(chunks.every((c) => c.text.length <= 1200), JSON.stringify(chunks.map((c) => c.text.length)))
})

test('a folder with more files than one import takes says so', async () => {
  const dir = path.join(work, 'many')
  for (let i = 0; i < 501; i++) file(`many/note-${String(i).padStart(3, '0')}.md`, `Note ${i}`)
  const more = { more: false }
  const files = await listFolder(dir, more)
  assert.equal(files.length, 500)
  assert.equal(more.more, true)
  const fewer = { more: false }
  await listFolder(path.join(work, 'many'), fewer)
  rmSync(path.join(dir, 'note-500.md'))
  const exact = { more: true }
  assert.equal((await listFolder(dir, exact)).length, 500)
  assert.equal(exact.more, false)
})

test('a document past what one holds, or an agent past what it searches, is refused with why', async () => {
  const store = new AgentStore(async () => '')
  await store.load()
  const agent = await store.create('sales')
  await assert.rejects(store.addText(agent.id, 'Huge', 'word '.repeat(1_000_001)), /more text than a document can \(5 million characters\)/)
  for (let i = 0; i < 4; i++) await store.addText(agent.id, `Part ${i}`, 'term '.repeat(980_000))
  await assert.rejects(store.addText(agent.id, 'One more', 'term '.repeat(200_000)), /would hold more than 20 million characters/)
  assert.equal(store.list().find((a) => a.id === agent.id).knowledge.length, 4)
})

test('a file pattern that would backtrack for minutes matches in a moment; patterns match as before', () => {
  const started = Date.now()
  assert.equal(globTest('**a**a**a**a**a**a**a**b')('a'.repeat(60)), false)
  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`)
  assert.equal(globTest('*.ts')('src/orders/app.ts'), true)
  assert.equal(globTest('*.ts')('src/orders/app.tsx'), false)
  assert.equal(globTest('src/orders/*')('src/orders/app.ts'), true)
  assert.equal(globTest('src/**')('src/a/b/c.ts'), true)
  assert.equal(globTest('app.?s')('src/app.ts'), true)
  assert.equal(globTest('APP.TS')('src/app.ts'), true, 'case does not matter')
  assert.equal(globTest('orders/*.ts')('src/orders/app.ts'), false, 'with a folder, from the top')
})

test("a file of long lines is read within what one answer takes", async () => {
  // Not inside Togle's own repository, which git would take it for.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-code-'))
  try {
    writeFileSync(path.join(dir, 'bundle.js'), Array.from({ length: 300 }, (_, i) => `var line${i} = "${'x'.repeat(3200)}";`).join('\n'))
    const code = new CodeBase([dir])
    const read = await code.read('bundle.js')
    assert.ok(read.length < 70_000, `${read.length.toLocaleString()} characters`)
    assert.match(read, /… \(3,21\d characters\)/)
    assert.match(read, /ask for more with start_line/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a file is read in its worker; one that fails there says why; a worker that can't start reads it here", async () => {
  const doc = file('plain.txt', 'Plain words to read.')
  setReaderScript(file('reader-ok.mjs', "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ value: 'read in the worker' })\n"))
  assert.equal(await extractText(doc), 'read in the worker')
  setReaderScript(file('reader-fails.mjs', "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ error: 'it unpacks to more than Togle reads' })\n"))
  await assert.rejects(extractText(doc), /unpacks to more than Togle reads/)
  setReaderScript(path.join(work, 'no-such-worker.mjs'))
  assert.equal(await extractText(doc), 'Plain words to read.')
  setReaderScript('')
})
