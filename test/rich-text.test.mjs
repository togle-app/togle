import test from 'node:test'
import assert from 'node:assert/strict'
import { externalUrl, richDocument, richPreview, richText } from './.build/togle.mjs'

const nested = tokens => tokens.flatMap(token => [token, ...nested(token.tokens ?? []), ...(token.items ?? []).flatMap(item => nested(item.tokens))])

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
