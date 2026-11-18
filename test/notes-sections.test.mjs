import assert from 'node:assert/strict'
import { test } from 'node:test'
const T = await import('./.build/togle.mjs')

// A call's notes as the notes view shows them (src/shared/notes-sections.ts): the lead, then a section for each "##" heading.

const notes = [
  '# Pricing review',
  '',
  'Lead sentence, with a time [1:02].',
  '',
  '## Marked',
  '- [2:14] Dario: ship it.',
  '',
  '## Decided',
  '- Two plans. [12:38]',
  '',
  '## To do',
  '- You: Send the table. [21:05]',
  '- Marta: Check the tax wording.',
  '- not a name: something',
  '',
  '## Open questions',
  '- Who owns staging?'
].join('\n')

test('notes are split into the lead and a section for each heading, with the title left out', () => {
  const parts = T.splitNotes(notes)
  assert.equal(parts.lead, 'Lead sentence, with a time [1:02].')
  assert.deepEqual(parts.sections.map((section) => [section.heading, section.kind]), [['Marked', 'marked'], ['Decided', 'decided'], ['To do', 'todo'], ['Open questions', 'open']])
  assert.equal(parts.sections[0].body, '- [2:14] Dario: ship it.', 'what is under a heading, as it was written')
  assert.equal(parts.sections.some((section) => section.body.includes('Pricing review')), false, 'the title is nowhere')
})

test('a section is of the kind its heading names', () => {
  for (const [heading, kind] of [['Marked', 'marked'], ['Highlights', 'marked'], ['Decided', 'decided'], ['Decisions', 'decided'], ['To do', 'todo'], ['To-do', 'todo'], ['Action items', 'todo'], ['Action list', 'todo'], ['Next steps', 'todo'], ['Open questions', 'open'], ['Outstanding decisions', 'open'], ['What happened', 'topic'], ['Budget', 'topic']]) {
    assert.equal(T.notesKind(heading), kind, heading)
  }
})

test('under To do the name of who took an item is bold, and nothing else is changed', () => {
  const todo = T.splitNotes(notes).sections.find((section) => section.kind === 'todo')
  assert.equal(todo.body, '- **You** Send the table. [21:05]\n- **Marta** Check the tax wording.\n- not a name: something', 'a name first; words that are not a name are left alone')
  const checked = T.splitNotes('## To do\n- [ ] Dario: write the FAQ\n- Not assigned: the footer').sections[0].body
  assert.equal(checked, '- [ ] **Dario** write the FAQ\n- Not assigned: the footer', 'a task box is kept, and "Not assigned" is not a name')
  // Other sections are as they were written.
  assert.equal(T.splitNotes('## Decided\n- Marta: Moves the date').sections[0].body, '- Marta: Moves the date')
})

test('a heading inside a code block is not a section; a table, a code block or a long section has a row of its own', () => {
  const text = '## Plan\n```\n## not a heading\n```\n\n## Owners\n| Task | Owner |\n| --- | --- |\n| One | Marta |\n\n## Short\n- one\n\n## Long\n' + 'word '.repeat(200)
  const parts = T.splitNotes(text)
  assert.deepEqual(parts.sections.map((section) => section.heading), ['Plan', 'Owners', 'Short', 'Long'])
  assert.deepEqual(parts.sections.map((section) => section.wide), [true, true, false, true])
  assert.ok(parts.sections[0].body.includes('## not a heading'), 'it stays in what the section holds')
})

test('the reference links of the whole notes go with each section, so that a link made elsewhere still works', () => {
  const parts = T.splitNotes('# T\n\nSee [the plan][p].\n\n## A\nRead [it][p].\n\n## B\nText.\n\n[p]: https://example.com/plan')
  assert.ok(parts.lead.endsWith('[p]: https://example.com/plan'))
  assert.ok(parts.sections[0].body.endsWith('[p]: https://example.com/plan'))
  assert.ok(parts.sections[1].body.endsWith('[p]: https://example.com/plan'))
})

test('notes with no sections are all lead, notes that are only a title are empty, and an empty section is left out', () => {
  assert.deepEqual(T.splitNotes('Just a line.\n\n- and a list'), { lead: 'Just a line.\n\n- and a list', sections: [] })
  assert.deepEqual(T.splitNotes('# Only a title'), { lead: '', sections: [] })
  assert.deepEqual(T.splitNotes('# T\n\n## Empty\n\n## Full\n- yes').sections.map((section) => section.heading), ['Full'])
  assert.deepEqual(T.splitNotes('## First section\r\n- one\r\n'), { lead: '', sections: [{ heading: 'First section', kind: 'topic', body: '- one', wide: false }] }, 'a line end of Windows is one')
  // A "#" heading that is not the first line is the notes' own, and stays.
  assert.ok(T.splitNotes('Intro\n\n# Later title\n\n## A\n- x').lead.includes('# Later title'))
})
