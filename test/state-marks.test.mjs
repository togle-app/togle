// The small marks that say what a task does (the turning ring of work, the dot that calls for the person, the ring with a dot of a task that
// waits on a shell it started, the square of a stopped one): every part of a mark has to be able to sit in the exact middle of its box. The box
// is 16px in a list and 12px in a chip, both even. A part with an odd size has half a pixel left over, and is drawn that half pixel to the right
// and down, which shows at this size: the 5px dot in the 14px ring did. A size in the stylesheet is all it takes, so that is what is read.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const css = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/src/design.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
/** The rules of the stylesheet, the innermost ones: what each selects, and what it declares. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((one) => one.trim()), body }))
const declared = (body, name) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()
/** A selector for a part of a mark (what is drawn inside the box), and the box it is drawn in. */
const PART = /^(\.state-chip > |\.todo-chip > )?\.state-mark(\[data-mark(?:='(\w+)')?\])?(?::not\([^)]*\))?(::before|::after| svg)$/
const boxOf = (selector) => (PART.exec(selector)?.[1] ? 'chip' : 'list')

test('a mark\'s box is 16px in a list and 12px in a chip', () => {
  const list = rules.find((rule) => rule.selectors.length === 1 && rule.selectors[0] === '.state-mark')
  assert.ok(list, 'the rule of the mark itself')
  assert.equal(declared(list.body, 'width'), '16px')
  assert.equal(declared(list.body, 'height'), '16px')
  const chip = rules.find((rule) => rule.selectors.includes('.state-chip > .state-mark') && rule.selectors.includes('.todo-chip > .state-mark'))
  assert.ok(chip, 'the rule of a mark in a chip')
  assert.equal(declared(chip.body, 'width'), '12px')
  assert.equal(declared(chip.body, 'height'), '12px')
})

test('every part of a mark can sit in the exact middle of its box: its size is a whole number of the box\'s own evenness', () => {
  const BOX = { list: 16, chip: 12 }
  const seen = { list: new Set(), chip: new Set() }
  for (const rule of rules) {
    const parts = rule.selectors.filter((selector) => PART.test(selector))
    if (!parts.length) continue
    assert.equal(parts.length, rule.selectors.length, `a rule for a part of a mark is for parts of marks only: ${rule.selectors.join(', ')}`)
    for (const selector of parts) {
      const [, , , mark = 'any', part] = PART.exec(selector)
      const box = BOX[boxOf(selector)]
      for (const side of ['width', 'height']) {
        const size = declared(rule.body, side)
        if (size === undefined) continue
        const whole = /^(\d+)px$/.exec(size)
        assert.ok(whole, `${selector}: ${side} is ${size}, and only a whole number of pixels can be centered at every screen scale`)
        assert.equal((box - Number(whole[1])) % 2, 0, `${selector}: ${side} is ${size} in a ${box}px box, so half a pixel is left over and the part is drawn off the middle`)
        seen[boxOf(selector)].add(`${mark}${part.trim()}`)
      }
      const inset = declared(rule.body, 'inset')
      if (inset !== undefined) assert.match(inset, /^\d+px$/, `${selector}: an inset is the same whole number on every side`)
    }
  }
  // The parts this is about were read: a stylesheet written another way must not pass by having nothing to check.
  for (const part of ['working::after', 'waiting::after', 'watching::before', 'watching::after', 'stopped::after', 'resting::after', 'anysvg']) assert.ok(seen.list.has(part), `read in a list: ${part} (${[...seen.list].join(', ')})`)
  for (const part of ['working::after', 'waiting::after', 'watching::before', 'watching::after', 'resting::after', 'anysvg']) assert.ok(seen.chip.has(part), `read in a chip: ${part} (${[...seen.chip].join(', ')})`)
})
