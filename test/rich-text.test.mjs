import test from 'node:test'
import assert from 'node:assert/strict'
import { externalUrl, localFilePath, richDocument, richPreview, richText, userMessageMarkdown } from './.build/togle.mjs'

test('a Codex installer link retains its full local destination including spaces', () => {
  const path = 'C:/Users/example/togle/dist/Togle Setup 0.1.0.exe'
  const token = richDocument('[Togle Free Windows installer](</' + path + '>)').blocks[0].tokens[0]
  assert.equal(token.type, 'link')
  assert.equal(localFilePath(token.href, 'win32'), path.replaceAll('/', '\\'))
  assert.equal(localFilePath('file:///C:/a/My%20Notes%23v2.txt', 'win32'), 'C:\\a\\My Notes#v2.txt')
  assert.equal(localFilePath('C:\\dev\\page.tsx:18:2', 'win32'), 'C:\\dev\\page.tsx')
  assert.equal(localFilePath('file:///home/user/r%C3%A9sum%C3%A9.pdf', 'linux'), '/home/user/résumé.pdf')
  assert.equal(localFilePath('/Users/test/100% ready.txt', 'darwin'), '/Users/test/100% ready.txt')
  for (const target of ['https://example.com/x','javascript:alert(1)','file://server/share/x','//server/share','%2F%2Fserver/share','relative.txt','file:///C:/a%00b']) {
    assert.equal(localFilePath(target, 'win32'), undefined)
    assert.equal(localFilePath(target, 'linux'), undefined)
  }
})

const nested = tokens => tokens.flatMap(token => [token, ...nested(token.tokens ?? []), ...(token.items ?? []).flatMap(item => nested(item.tokens))])

test('an old one-line prompt with a complete table regains its rows and section boundaries for display', () => {
  const report = 'review this # Device plans Choose **one plan**. | Name | What you get | |---|:---:| | **Free** | Use one PC. | | **Pro** | Connect devices. | ### 1. Connect a phone. ### 2. Review the [roadmap](https://example.com).'
  const blocks = richDocument(userMessageMarkdown(report)).blocks
  const table = blocks.find(block => block.type === 'table')
  assert.deepEqual(table.header.map(cell => cell.text), ['Name', 'What you get'])
  assert.deepEqual(table.rows.map(row => row.map(cell => cell.text)), [['**Free**', 'Use one PC.'], ['**Pro**', 'Connect devices.']])
  assert.equal(table.header[1].align, 'center')
  assert.equal(blocks[0].text, 'review this')
  assert.equal(blocks.find(block => block.type === 'list').items.length, 2)
  assert.equal(nested(blocks).find(token => token.type === 'link').href, 'https://example.com')
  const symbols = 'Use # for a comment. | A | B | |---|---| | 1 | 2 | ### 1. Handle C# and issue #42. Type # here.'
  assert.ok(userMessageMarkdown(symbols).startsWith('Use # for a comment.\n\n'))
  assert.ok(userMessageMarkdown(symbols).endsWith('1. Handle C# and issue #42. Type # here.'))
})

test('normal Markdown, code examples and ambiguous pipes keep their original text', () => {
  for (const text of ['# Review\n\n| A | B |\n|---|---|\n| 1 | 2 |', 'C# and issue #42', 'a | b | c', 'Use `| A | B | |---|---| | 1 | 2 |`', '| A | B | C | |---|---| | 1 | 2 |', '| A | B | |---|---| | 1 | 2 | 3 |', '| A | B | |---|---|']) {
    assert.equal(userMessageMarkdown(text), text)
  }
})

test('web and email links are canonical destinations; custom/executable schemes cannot open', () => {
  assert.equal(externalUrl('HTTPS://EXAMPLE.COM/meeting?q=one#notes'), 'https://example.com/meeting?q=one#notes')
  assert.equal(externalUrl('mailto:team@example.com?subject=Meeting'), 'mailto:team@example.com?subject=Meeting')
  for (const value of [null, {}, [], '', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///C:/notes', 'obsidian://open?vault=work', '//example.com', 'https://user:password@example.com', 'https://', 'mailto:', 'mailto:team@example.com%0ABcc:other@example.com']) assert.equal(externalUrl(value), undefined, JSON.stringify(value))
})

test('Jira/GitHub links, bare URLs, punctuation and reference links retain their intended targets', () => {
  const doc = richDocument('[SOH-123](https://work.atlassian.net/browse/SOH-123) and https://github.com/team/project/pull/9. Read [release][ref].\n\n[ref]: https://example.com/release')
  const links = nested(doc.blocks).filter(token => token.type === 'link')
  assert.deepEqual(links.map(token => token.href), ['https://work.atlassian.net/browse/SOH-123', 'https://github.com/team/project/pull/9', 'https://example.com/release'])
  assert.ok(doc.references.includes('https://example.com/release'))
})

test('rich replies preserve tables, nested lists, task state, blockquotes and code', () => {
  const text = '# Release\n\n> Confirm the owner.\n\n3. Review\n   - [x] Tests passed\n   - [ ] Deploy\n\n| Item | Owner |\n| --- | --- |\n| Callback | **Denis** |\n\n```ts\nconst url = "https://example.com";\n```'
  const tokens = nested(richDocument(text).blocks)
  for (const kind of ['heading', 'blockquote', 'list', 'checkbox', 'table', 'code']) assert.ok(tokens.some(token => token.type === kind), kind)
  assert.equal(tokens.find(token => token.type === 'list').start, 3)
  assert.deepEqual(tokens.filter(token => token.type === 'checkbox').map(token => token.checked), [true, false])
  assert.equal(tokens.find(token => token.type === 'code').text, 'const url = "https://example.com";')
})

test('streamed fences and links remain readable and resolve when their syntax completes', () => {
  const text = '**Release**: [Open ticket](https://example.com/issues/123)\n\n```ts\nconst ready = true;\n```'
  for (let index = 1; index <= text.length; index++) assert.doesNotThrow(() => richDocument(text.slice(0, index)))
  assert.equal(richDocument('```ts\nconst ready = true;').blocks[0].type, 'code')
  const before = richDocument('Read [release][ref].')
  const after = richDocument('Read [release][ref].\n\n[ref]: https://example.com')
  assert.notEqual(before.references, after.references, 'A late reference must invalidate memoized earlier blocks')
  assert.ok(nested(after.blocks).some(token => token.type === 'link'))
})

test('folded replies show readable labels and punctuation instead of Markdown link syntax', () => {
  assert.equal(richPreview('## Update\n\nSee [the **Jira** ticket](https://example.com), then `npm test`.\n\n- Confirm *owner*\n- Send ~~old~~ new notes'), 'Update See the Jira ticket, then npm test. Confirm owner Send old new notes')
  assert.equal(richText('Caf&eacute; &amp; &#x4f60;&#x597d;'), 'Café & 你好')
})

test('oversized pasted output stays intact without a costly Markdown tree', () => {
  const text = 'Full log https://example.com\n'.repeat(8000)
  const doc = richDocument(text)
  assert.equal(doc.plain, text)
  assert.deepEqual(doc.blocks, [])
})
