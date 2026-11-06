// Group calls: automatic suggestions only for the questions meant for me.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotWith, quick, wait, workDir } from './helpers.mjs'

workDir('group')
const { AgentStore, Copilot, updateSettings } = await import('./.build/togle.mjs')

const store = new AgentStore(async () => 'digest')
await store.load()
await updateSettings({ assist: { auto: true, names: 'Luka, Luke' } })

/**
 * A call where lines come in as they would be said, a little apart (each said from `start` to `end` seconds before
 * it comes in); returns the questions suggestions answered.
 */
async function call(group, lines) {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(group)
  for (const [speaker, text, start = 2, end = 0] of lines) {
    copilot.add(speaker, text, Date.now() - start * 1000, Date.now() - end * 1000)
    // Long enough for an automatic suggestion to fire, even after a line that isn't a question.
    await wait(1500)
  }
  return quick(inputs).map((input) => /What they just said, which is what to answer: "([^"]+)"/.exec(input.user)?.[1])
}

test('in a group call, a question to someone else by name gets no suggestion; one to me does', async () => {
  const answered = await call(true, [
    ['them', 'Marko, can you share the numbers from last week?'],
    ['them', 'Luka, what is your take on the rollout?']
  ])
  assert.deepEqual(answered, ['Luka, what is your take on the rollout?'])
})

test("in a group call, a question naming nobody is mine when it follows what I said, not someone else's turn", async () => {
  const answered = await call(true, [
    ['me', 'We can export the reports to Excel every Monday.'],
    ['them', 'Can you clarify what goes into that export?'],
    ['them', 'Thanks, that helps.'],
    ['them', 'What is the timeline for the next release?']
  ])
  assert.deepEqual(answered, ['Can you clarify what goes into that export?'])
})

test('in a group call, an "Okay." between what I said and their question still leaves it mine', async () => {
  const answered = await call(true, [
    ['me', 'We support single sign-on with Okta.'],
    ['them', 'Okay.'],
    ['them', 'And how long does the setup take?']
  ])
  assert.equal(answered.length, 1)
  assert.match(answered[0], /And how long does the setup take\?$/)
})

test('in a group call, a line of mine that comes in late shows their question followed it', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(true)
  const asked = Date.now()
  copilot.add('them', 'How long does the setup take?', asked, asked + 1500)
  await wait(1500)
  assert.equal(quick(inputs).length, 0, 'nothing of mine before it yet')
  // Mine, said just before it, transcribed again for being unclear.
  copilot.add('me', 'We support single sign-on with Okta.', asked - 3000, asked - 400)
  await wait(100)
  assert.equal(quick(inputs).length, 1)
  assert.match(quick(inputs)[0].user, /What they just said, which is what to answer: "How long does the setup take\?"/)
})

test("in a group call, a product or a topic opening a question isn't someone's name", async () => {
  const product = await call(true, [
    ['me', 'We stream the changes from your database.'],
    ['them', 'Debezium, is that what you use for it?']
  ])
  assert.deepEqual(product, ['Debezium, is that what you use for it?'])
  const topic = await call(true, [
    ['me', 'We encrypt everything at rest and in transit.'],
    ['them', 'Security, how do you handle access control?']
  ])
  assert.deepEqual(topic, ['Security, how do you handle access control?'])
})

test('in a group call, a second question right after the first goes on asking me', async () => {
  const answered = await call(true, [
    ['me', 'We support single sign-on with Okta.'],
    ['them', 'How long does the setup take?'],
    ['them', 'And do you need admin rights for that?']
  ])
  assert.deepEqual(answered, ['How long does the setup take?', 'And do you need admin rights for that?'])
})

test('in a group call, a "Mhm." while I talk leaves their question after it mine', async () => {
  const answered = await call(true, [
    ['me', 'So the way it works is that we stream every change from your database into our warehouse, and the reports are rebuilt every night.', 24, 2],
    ['them', 'Mhm.', 23, 22.5],
    ['them', 'And how long does the setup take?', 0.5, 0]
  ])
  assert.equal(answered.length, 1)
  assert.match(answered[0], /And how long does the setup take\?$/)
})

test('in a group call, a question after a line said to someone else by name is theirs too', async () => {
  const answered = await call(true, [
    ['me', 'We can export the reports to Excel every Monday.'],
    ['them', 'Marko, quick question.'],
    ['them', 'Can you share the numbers from last week?']
  ])
  assert.deepEqual(answered, [])
})

test('in a call between two, every question gets its suggestion, named or not', async () => {
  const answered = await call(false, [
    ['them', 'Marko, can you share the numbers from last week?'],
    ['them', 'Thanks, that helps.'],
    ['them', 'What is the timeline for the next release?']
  ])
  assert.equal(answered.length, 2)
  assert.equal(answered[0], 'Marko, can you share the numbers from last week?')
  assert.match(answered[1], /What is the timeline for the next release\?$/)
})

test('in a group call, nothing starts at the pause for a question to someone else', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(true)
  copilot.anticipate('Ana, could you send the contract by Friday?', Date.now(), 'seg-1')
  await wait(50)
  assert.equal(quick(inputs).length, 0)
  copilot.anticipate('And Luka, does that date work for you?', Date.now(), 'seg-2')
  await wait(50)
  assert.equal(quick(inputs).length, 1)
  assert.match(quick(inputs)[0].user, /does that date work for you/)
})

test("in a group call, a late line of mine brings no suggestion once I've replied to their question", async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(true)
  const asked = Date.now()
  copilot.add('them', 'How long does the setup take?', asked, asked + 1500)
  await wait(1500)
  copilot.add('me', 'About a day, usually.', asked + 2000, asked + 3000)
  copilot.add('me', 'We support single sign-on with Okta.', asked - 3000, asked - 400)
  await wait(100)
  assert.equal(quick(inputs).length, 0)
})

test('in a group call, Suggest pressed for their question and then a late line of mine bring one card, not two', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(true)
  const asked = Date.now()
  copilot.add('them', 'How long does the setup take?', asked, asked + 1500)
  await wait(1500)
  await copilot.assist({ kind: 'suggest' })
  copilot.add('me', 'We support single sign-on with Okta.', asked - 3000, asked - 400)
  await wait(100)
  assert.equal(quick(inputs).length, 1)
})

test('in a group call, nothing starts at the pause for a question going on from a line said to someone else', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(true)
  copilot.add('me', 'We can export the reports to Excel every Monday.', Date.now() - 4000, Date.now() - 1000)
  copilot.add('them', 'Marko, regarding that export,', Date.now() - 900, Date.now(), 'seg-a')
  await wait(1500)
  copilot.anticipate('can you share the numbers from last week?', Date.now() - 1000, 'seg-b')
  await wait(50)
  assert.equal(quick(inputs).length, 0)
})

test('in a group call, a thank-you to me between what I said and their question keeps it mine', async () => {
  const answered = await call(true, [
    ['me', 'We support single sign-on with Okta.'],
    ['them', 'Great, thanks Luka.'],
    ['them', 'Yeah, makes sense.'],
    ['them', 'And how long does the setup take?']
  ])
  assert.equal(answered.length, 1)
  assert.match(answered[0], /And how long does the setup take\?$/)
})

test('in a group call, a question answered by pressing Suggest goes on asking me with its follow-up', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.setGroup(true)
  copilot.add('them', 'How long does the setup take?', Date.now() - 1500, Date.now())
  await wait(1500)
  assert.equal(quick(inputs).length, 0, 'nothing of mine before it: not taken as mine')
  await copilot.assist({ kind: 'suggest' })
  copilot.add('them', 'And do you need admin rights for that?', Date.now() - 1500, Date.now())
  await wait(1500)
  assert.equal(quick(inputs).length, 2)
})
