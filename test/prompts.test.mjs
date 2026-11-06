// The answer prompt: what comes first, so the backend can reuse it from its cache.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('prompts')
const { AgentStore, buildPrompt } = await import('./.build/togle.mjs')

const store = new AgentStore(async () => 'digest')
await store.load()
const agent = store.list()[0]

test('the timeline is cut a step at a time, so prompts in a row start the same way', async () => {
  const knowledge = await store.knowledgeFor(agent, 'price', new Set())
  const t0 = Date.now() - 3_600_000
  const transcript = Array.from({ length: 140 }, (_, i) => ({
    id: `line-${i}`,
    speaker: i % 2 ? 'me' : 'them',
    text: `Point ${i}: ${'we talked it through '.repeat(8)}`,
    at: t0 + i * 20_000,
    end: t0 + i * 20_000 + 5_000
  }))
  const userFor = (n) =>
    buildPrompt({ request: { kind: 'suggest' }, part: 'main', question: 'What does it cost?', transcript: transcript.slice(0, n), frames: [], attached: new Set(), agent, knowledge, canSearch: false }).user
  const timelineOf = (user) => user.split('\n\n').find((part) => part.startsWith('Timeline of the call'))
  // Everything up to the end of the timeline: what the next prompt must start with to be read from the cache.
  const head = (user) => user.slice(0, user.indexOf(timelineOf(user)) + timelineOf(user).length)
  let moves = 0
  for (let n = 100; n < 140; n++) {
    const timeline = timelineOf(userFor(n))
    assert.ok(timeline.length > 14_000 && timeline.length < 14_000 + 3_500 + 400, `never less of the call than before, at most a step more: ${timeline.length}`)
    assert.match(timeline, /\[…earlier part of the call omitted…\]/)
    if (!userFor(n + 1).startsWith(head(userFor(n)))) moves++
  }
  // 40 lines are about 7,500 characters: two steps of 3,500, where cutting line by line moved the start 40 times.
  assert.ok(moves >= 1 && moves <= 3, `${moves} moves`)
})

test('the call so far is cut into blocks at the same lines in each prompt, up to its newest lines, for a cache that reads by block', async () => {
  const knowledge = await store.knowledgeFor(agent, 'price', new Set())
  const t0 = Date.now() - 600_000
  const transcript = Array.from({ length: 60 }, (_, i) => ({
    id: `line-${i}`,
    speaker: i % 2 ? 'me' : 'them',
    text: `Point ${i} about the rollout.`,
    at: t0 + i * 9_000,
    end: t0 + i * 9_000 + 4_000
  }))
  const prompt = (n, now) =>
    buildPrompt({
      request: { kind: 'suggest' },
      part: 'main',
      question: 'What does it cost?',
      transcript: transcript.slice(0, n),
      frames: [],
      attached: new Set(),
      agent,
      knowledge,
      canSearch: false,
      brief: 'Renewal call with Acme.',
      notes: '- They use Salesforce.',
      settledBefore: now - 90_000
    })
  const first = prompt(50, t0 + 50 * 9_000)
  const next = prompt(60, t0 + 60 * 9_000)
  assert.ok(first.userCuts.length >= 3, `${first.userCuts.length} cuts`)
  // Every cut of the first prompt is one of the next's, with the same text before it: blocks that repeat.
  for (const cut of first.userCuts) {
    assert.ok(next.userCuts.includes(cut))
    assert.equal(next.user.slice(0, cut), first.user.slice(0, cut))
  }
  assert.ok(next.userCuts.length > first.userCuts.length, 'more of the call has settled since')
  // Each block ends after a line, and the newest lines (still changing) come after the last cut.
  for (const cut of next.userCuts) assert.equal(next.user[cut - 1], '\n')
  const last = next.user.slice(next.userCuts.at(-1))
  assert.match(last, /Point 5[0-5] about the rollout\./)
  assert.match(last, /What they just said/)
  // Without a time when lines have settled (the review, the notes), no cuts.
  assert.deepEqual(buildPrompt({ ...{ request: { kind: 'suggest' }, part: 'main', question: 'Q', transcript, frames: [], attached: new Set(), agent, knowledge, canSearch: false } }).userCuts, [])
})

test("the instructions, then the call, then what changes with every request: the start is reused from the cache", async () => {
  const knowledge = {
    ...(await store.knowledgeFor(agent, 'price', new Set())),
    passages: [{ id: 'p1', n: 1, doc: 'Pricing', section: 'Plans', text: 'Growth is 39 euros per user a month.' }],
    answers: 'Q: Do you integrate with SAP?\nA: Yes, through a partner connector.',
    allAnswers: false
  }
  const at = Date.now() - 60_000
  const { user } = buildPrompt({
    request: { kind: 'suggest' },
    part: 'main',
    question: 'What does Growth cost?',
    transcript: [{ id: 'q', speaker: 'them', text: 'What does Growth cost?', at, end: at + 2_000 }],
    frames: [],
    attached: new Set(),
    agent,
    knowledge,
    canSearch: false,
    notes: '- They use Salesforce.',
    callAnswers: [{ question: 'Is there a trial?', answer: 'Yes, 14 days.' }]
  })
  // The quick answer's instructions are the same for every request: first, so they lengthen the start the backend
  // caches (from about 2,048 tokens on); the question last.
  const order = [
    'LEVEL: quick',
    'Notes on the call so far',
    'Timeline of the call',
    'Answers I approved or corrected earlier',
    'Approved answers that may match',
    'Passages from my knowledge base',
    'What they just said'
  ]
  const positions = order.map((heading) => user.indexOf(heading))
  assert.ok(
    positions.every((p) => p >= 0),
    String(positions)
  )
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions
  )
})

test('only clearly hard questions start the strong model before the fast answer has judged them', async () => {
  const { looksDeep } = await import('./.build/togle.mjs')
  const everyday = [
    'How do we get started?',
    'How do we pay, by card or invoice?',
    'What happens if we cancel after a month?',
    'How would you handle a difficult customer?',
    'How should we follow up after this call?',
    'What would happen to our data if we leave?',
    'Are there any exceptions to the refund policy?',
    'Have you ever had a data leak?',
    'Can you walk me through your CV?',
    'What are the pros and cons of the yearly plan?',
    'Kako biste opisali svoj stil vođenja?',
    "So we're about forty people across three offices, mostly sales and support, we use HubSpot and a bit of Salesforce, and honestly our biggest problem is nobody trusts the numbers, so what would you suggest we start with?"
  ]
  assert.deepEqual(everyday.filter((q) => looksDeep(q)), [])
  assert.equal(looksDeep('How would you design a rate limiter for fifty thousand requests per second?'), 'strong')
  assert.equal(looksDeep("Our Node service's memory keeps climbing until it crashes every few hours. Where would you start?"), 'strong')
  assert.equal(looksDeep('Kako biste dizajnirali sustav za obradu narudžbi?'), 'strong')
  assert.equal(looksDeep('Aplikacija se ruši kad kliknem na export, zašto?'), 'strong')
  assert.equal(looksDeep('Konkurencija ruši cijene, što biste vi napravili?'), undefined)
  // Pointing at code on the screen: likely about it, so it starts early, but the verdict can still drop it.
  assert.equal(looksDeep('Why does this return null?', 'Code: a TypeScript function mergeOrders that…'), 'weak')
  assert.equal(looksDeep('Why does this return null?', 'Slide: Q3 revenue by region'), undefined)
})

test('a deep answer starts early for a question about code on the screen, not for one about a slide that only sounds like code', async () => {
  const { looksDeep } = await import('./.build/togle.mjs')
  const code = [
    'Code: a TypeScript function mergeOrders that merges two arrays of orders.',
    'Code (Go): func handleRequest(w http.ResponseWriter, r *http.Request) with a missing error check.',
    'VS Code with checkout.ts open: applyDiscount returns null when the cart is empty.',
    'Terminal: npm test output, 3 tests failing in cart.spec.ts.',
    'A Python traceback: KeyError: "sku" in parse_order, line 42.',
    'IntelliJ showing OrderService.java; calculateTotal throws a NullPointerException.',
    'A pull request diff of src/billing/invoice.rb: two lines changed in the tax calculation.',
    'An SQL query in DBeaver joining orders and customers.',
    'Stack trace in the browser console: TypeError: Cannot read properties of undefined.',
    'The method calculateTotal in a C# class, with a loop over the line items.',
    'Jupyter notebook: a pandas dataframe with a groupby on region.'
  ]
  const slides = [
    'Slide: Pricing. Starter 19 EUR, Growth 39 EUR per seat. Payment methods: card, SEPA, invoice.',
    'Slide: Product functionality overview: dashboards, alerts, scheduled exports.',
    'Slide: World-class support, 24/7, 99.9% uptime SLA.',
    'Event page with a QR code to register for the webinar.',
    'Dashboard: churn 2.1%, error rate 0.3%, NPS 54.',
    'Slide: Our classes of service: Gold, Silver and Bronze.',
    'Checkout page with a discount code field and a Pay now button.',
    'Code of conduct for partners, five rules.',
    'Slide: Integrations: GitHub, Jira, Slack, Salesforce.',
    'Slide: International payments by SWIFT transfer, 2 to 3 days.',
    'Slide: Error budget and SLOs for Q3.'
  ]
  const question = 'Is that right?'
  assert.deepEqual(code.filter((note) => looksDeep(question, note) !== 'weak'), [])
  assert.deepEqual(slides.filter((note) => looksDeep(question, note)), [])
})

test('debugging and building systems in Croatian start the strong model at once; a mistake on an invoice does not', async () => {
  const { looksDeep } = await import('./.build/togle.mjs')
  const debugging = [
    'Imamo grešku u produkciji od jutros, gdje biste počeli?',
    'Servis se stalno ruši nakon deploya, gdje biste počeli?',
    'Server se srušio u noći, kako biste pronašli uzrok?',
    'Javlja nam se greška 500 na checkoutu, što biste provjerili?',
    'Gdje je greška u ovom kodu?',
    'Kako biste pronašli uzrok curenja memorije?',
    'Kako biste napravili sustav za plaćanja?',
    'How would you build a payment system?',
    'How would you implement the job queue for this?'
  ]
  assert.deepEqual(debugging.filter((q) => looksDeep(q) !== 'strong'), [])
  const everyday = [
    'Je li to bila greška u računu?',
    'Greškom sam vam poslao krivu ponudu, možete li je zanemariti?',
    'Što ako napravimo grešku pri narudžbi?',
    'Moja greška, možete li ponoviti cijenu?',
    'Rusi su nam najveći kupci, radite li s njima?',
    'Ruši li to cijenu ako uzmemo godišnji plan?',
    'Kako biste napravili plan za prvih devedeset dana?',
    'How would you build trust with a new client?',
    'Imali smo grešku kod nas u uredu, ništa strašno.',
    'Ima li greška od 250 eura na računu za ožujak?',
    'Je li greška od 450 eura na računu?',
    'Imamo grešku od 450,00 € na računu?',
    'Imamo grešku od 450 KM na računu, šta da radimo?',
    'Napravili smo grešku sa 400 narudžbi?',
    'Can you give me a crash course on your pricing?',
    'Can you give me a crash-course on your pricing?'
  ]
  assert.deepEqual(everyday.filter((q) => looksDeep(q)), [])
  // An HTTP status, however it's written down.
  for (const q of ['Dobivamo grešku 404.', 'Greška HTTP 500?', 'greška: 502 Bad Gateway?', 'Dobivamo grešku 500-icu kad kliknemo?', 'Stalno nam izlazi 500ica.']) {
    assert.equal(looksDeep(q), 'strong', q)
  }
})

test('a stack trace pasted into the Ask box starts the strong model at once', async () => {
  const { looksDeep } = await import('./.build/togle.mjs')
  const node = ["TypeError: Cannot read properties of undefined (reading 'total')", '    at mergeOrders (src/orders.ts:42:17)', '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'].join('\n')
  const python = ['Traceback (most recent call last):', '  File "app.py", line 12, in <module>', '    main()', "KeyError: 'user'"].join('\n')
  const java = ['Exception in thread "main" java.lang.NullPointerException', '\tat com.acme.Orders.merge(Orders.java:42)'].join('\n')
  for (const trace of [node, python, java]) assert.equal(looksDeep(trace), 'strong', trace)
  assert.equal(looksDeep('We got an error at checkout yesterday, any idea why?'), undefined, 'the word alone is not a trace')
})

test('a frame description says when it shows only people, or nothing new', async () => {
  const { readFrameNote } = await import('./.build/togle.mjs')
  assert.deepEqual(readFrameNote('PEOPLE: Ana and Marko on camera.'), { note: 'Ana and Marko on camera.', people: true, unchanged: false })
  assert.deepEqual(readFrameNote('**PEOPLE:** Ana on camera'), { note: 'Ana on camera', people: true, unchanged: false })
  assert.deepEqual(readFrameNote('SAME'), { people: false, unchanged: true })
  assert.deepEqual(readFrameNote('SAME.'), { people: false, unchanged: true })
  assert.deepEqual(readFrameNote('Same slide as F3, with a new arrow from API to Queue.'), {
    note: 'Same slide as F3, with a new arrow from API to Queue.',
    people: false,
    unchanged: false
  })
  // Only the bare markers count: a reply that goes on says what changed, and a title in capitals is a description.
  assert.deepEqual(readFrameNote('SAME, but the presenter added a third bullet: Churn down 4%'), {
    note: 'SAME, but the presenter added a third bullet: Churn down 4%',
    people: false,
    unchanged: false
  })
  assert.deepEqual(readFrameNote('PEOPLE OPS dashboard: headcount 120'), { note: 'PEOPLE OPS dashboard: headcount 120', people: false, unchanged: false })
  assert.deepEqual(readFrameNote('**PEOPLE**: Ana on camera'), { note: 'Ana on camera', people: true, unchanged: false })
})

test("the brief reaches the running notes and the call's review too", async () => {
  const { buildCallNotesPrompt, buildLearnPrompt } = await import('./.build/togle.mjs')
  const entries = [{ id: 'a', speaker: 'them', text: 'We run Salesforce.', at: Date.now(), end: Date.now() + 2000 }]
  const brief = 'Renewal call with Acme; I want the three-year deal.'
  assert.ok(buildCallNotesPrompt('', entries, [], brief).user.startsWith(`About this call (my brief): ${brief}`))
  assert.match(buildLearnPrompt(agent, entries, [], '', [], brief).user, /What this call was for \(my brief\): Renewal call with Acme/)
  assert.doesNotMatch(buildLearnPrompt(agent, entries, [], '', []).user, /my brief/)
})

test('who a turn speaks to by name: me, someone else, or nobody named', async () => {
  const { addressedTo } = await import('./.build/togle.mjs')
  const me = ['Luka', 'Luke']
  const to = (text) => addressedTo(text, me)
  assert.equal(to('Marko, can you share the numbers?'), 'other')
  assert.equal(to('What do you think, Ana?'), 'other')
  assert.equal(to('Hey Marko, quick one: is the export fixed?'), 'other')
  assert.equal(to('Luka, what is your take on this?'), 'me')
  assert.equal(to('What do you think, Luke?'), 'me')
  assert.equal(to('Thanks, Marko. Now, Luka, how would you do it?'), 'me', 'named both: I am asked too')
  assert.equal(to('Željko, imaš li brojke?'), 'other')
  // Openers that look like names but address nobody.
  for (const text of ['Okay, what does it cost?', 'Honestly, when could you start?', 'Guys, any questions?', 'So what do we do next?', 'Realistically, can we ship in March?']) {
    assert.equal(to(text), undefined, text)
  }
  // A name said about someone isn't said to them, and names in what they tell me ask nothing.
  assert.equal(to('As Marko said, the export is slow. Can you fix it?'), undefined)
  assert.equal(to('We use Salesforce, HubSpot, and Excel. What do you integrate with?'), undefined)
  assert.equal(to('Okay, Excel.'), undefined)
  // Words beside a comma that aren't anyone: openers, products, months.
  for (const text of [
    'Excellent, when can you start?',
    'Interesting, how does it scale?',
    'Does it integrate with our ERP, SAP?',
    'Which CRM do you use today, HubSpot?',
    'Could we do the kickoff next month, October?',
    'Do you also connect to our CRM, Salesforce?'
  ]) {
    assert.equal(to(text), undefined, text)
  }
  assert.equal(to('Excellent, Marko, can you share the numbers?'), 'other')
  assert.equal(to('Any thoughts, Ana?'), 'other')
  // A full name in Settings answers to the first name.
  assert.equal(addressedTo('Luka, what is your take?', ['Luka Dutina']), 'me')
  assert.equal(addressedTo('What do you think, Dutina?', ['Luka Dutina']), 'me')
})

test('a statement that asks for an answer wants one, in the languages calls are taken in', async () => {
  const { needsReply } = await import('./.build/togle.mjs')
  for (const text of [
    "I'd like to know how you price the enterprise plan.",
    'I’d also like to understand the migration.',
    'I want to know what happens to our data.',
    "I'm curious about the roadmap.",
    "I'd be curious to hear how you handle refunds.",
    "We'd like to know how you handle GDPR.",
    'Would love to hear more about the roadmap.',
    'I wonder how that scales past a million rows.',
    'So, I was wondering about the onboarding.',
    'Give me a bit of background on the team.',
    'Zanima me kako to radi s našim ERP-om.',
    'Zanimalo bi me kako to radi.',
    'Mene zanima koliko košta.',
    'Htio bih znati koliko traje uvođenje.',
    'Željela bih znati koliko košta.',
    'Pitam se kako to skalira.',
    'Reci mi nešto o svom zadnjem projektu.',
    'Ich möchte wissen, wie das funktioniert.',
    'Quisiera saber cuánto cuesta.',
    'Je me demande comment ça marche.'
  ]) {
    assert.equal(needsReply(text), true, text)
  }
  // Each of these would start a suggestion for nothing.
  for (const text of [
    'I like that approach.',
    'We want to start in March.',
    "I'm sure it works.",
    'Zanimljivo, to nisam znao.',
    'Okay, give me a second.',
    "Give me a sec, I'm writing this down.",
    'Tell me if you need anything else.',
    'Show me later, no rush.',
    'I was wondering the same thing.',
    "I'm curious too.",
    'I wonder.',
    "Thanks, I'd love to see that.",
    "We're interested in moving forward.",
    'I need to understand this better, let me read the docs first.'
  ]) {
    assert.equal(needsReply(text), false, text)
  }
})

test('who a turn speaks to: words that open a sentence, products, and my name however it comes', async () => {
  const { addressedTo } = await import('./.build/togle.mjs')
  const to = (text) => addressedTo(text, ['Luka', 'Luke'])
  // A word after "And" or "So" with no comma after it is what they ask about.
  for (const text of ['And Excel?', 'So Python, right?', 'Lastly, what about pricing?', 'Next, can you show the dashboard?']) {
    assert.equal(to(text), undefined, text)
  }
  for (const text of ['Hej, možeš li podijeliti ekran?', 'Dečki, ima li pitanja?', 'Kolege, što mislite?', 'Petak, može?', 'What, you mean today?']) {
    assert.equal(to(text), undefined, text)
  }
  assert.equal(to('Bok, Marko, imaš li minutu?'), 'other')
  assert.equal(to('Okay so Marko, what do you think?'), 'other')
  assert.equal(to('That makes sense, and Marko, how does that work for you?'), 'other')
  assert.equal(to('We use Excel, Word, and Outlook, right?'), undefined, 'a list of things')
  // Someone else is said to by a name people have: a product, a topic or a word that opens a question isn't one.
  for (const text of [
    'Kubernetes, is that what you run on?',
    'Security, how do you handle that?',
    'Performance, what does it look like at scale?',
    'Still, how long does the setup take?',
    'Apologies, could you repeat the last part?',
    'Furthermore, how do you handle refunds?',
    'Yup, and how long does the setup take?',
    'Mm-hmm, and what about the API?',
    'Čuj, a koliko to košta?',
    'Nego, kako ste vi to riješili?',
    'Usput, kad možete poslati ponudu?',
    'Summer, how busy does it get?',
    'London, do you have a data center there?'
  ]) {
    assert.equal(to(text), undefined, text)
  }
  // Speech recognition often leaves the commas out: my own name is trusted without them, unless I'm asked about.
  for (const text of [
    'Luka what do you think?',
    'Okay Luka what about the timeline?',
    'What do you think Luka?',
    'What about you Luka?',
    'Does that work for you Luka?',
    'We can ship it by Friday, right Luka?',
    'Can you share your screen Luka?',
    'Any questions Luka?',
    'A ti Luka?'
  ]) {
    assert.equal(to(text), 'me', text)
  }
  assert.equal(to('Did you talk to Luka?'), undefined, 'asked about me, of someone else')
  assert.equal(to('Do you know Luka?'), undefined)
  assert.equal(to('Is this for Luka?'), undefined)
  assert.equal(to('Marko what do you think?'), undefined, "someone else's name without a comma is only a word")
  // Several said to at once, me among them.
  for (const text of ['Ana and Luka, what do you think?', 'Marko, Ana, Luka, can you three sync on this?', 'What do you think, Ana and Luka?', 'Luka, Marko, what do you two think?']) {
    assert.equal(to(text), 'me', text)
  }
  // Said to someone in a sentence of its own, with the question after it.
  assert.equal(to('Luka? Do you have a minute?'), 'me')
  assert.equal(to('Thanks, Luka. What about the timeline?'), 'me')
  assert.equal(to('Thanks Luke. And the budget?'), 'me')
  assert.equal(to('Thanks, Luka. Marko, what do you think?'), 'other', 'the question names someone else')
  assert.equal(to('Marko, quick question. Can you share the numbers from last week?'), 'other')
  assert.equal(to('Marko? Can you share the numbers?'), 'other')
  assert.equal(to('Which one do you use? Excel? Or Sheets?'), undefined)
  // A title before a surname: "Mr." (Gospodine) Dutina.
  assert.equal(addressedTo('Gospodine Dutina, što mislite?', ['Luka Dutina']), 'me')
  // Said to me in Croatian, a name changes: Ivan is "Ivane", Petar "Petre", Maja "Majo", Matej "Mateju".
  assert.equal(addressedTo('Ivane, možeš li to provjeriti?', ['Ivan']), 'me')
  assert.equal(addressedTo('Petre, što misliš?', ['Petar']), 'me')
  assert.equal(addressedTo('Majo, imaš li brojke?', ['Maja']), 'me')
  assert.equal(addressedTo('Mateju, kada možeš?', ['Matej']), 'me')
  assert.equal(addressedTo('Ivane, možeš li to provjeriti?', ['Luka']), 'other')
  // My name counts even where it looks like a word that names nobody.
  assert.equal(addressedTo('Kimberly, can you share the numbers?', ['Kimberly']), 'me')
  assert.equal(addressedTo('April, what do you think?', ['April']), 'me')
})

test('a request to a group ("Tell us…"), after "Please", or followed by more of what they say, wants an answer; asides do not', async () => {
  const { needsReply, isSmallTalk } = await import('./.build/togle.mjs')
  for (const text of [
    'Tell us a bit about yourself.',
    'Walk us through your architecture.',
    'Give us an overview of the pricing.',
    'Please walk me through the setup.',
    'Just walk me through it.',
    'Recite nam nešto o sebi.',
    'Walk me through your onboarding process. We have about forty people. Most of them are in sales.',
    'Zanima me kako to radi. Imamo tri tima. Svaki ima svoj budžet.'
  ]) {
    assert.equal(needsReply(text), true, text)
  }
  for (const text of [
    'Give me five minutes.',
    'Give me a quick second.',
    'Okay, give me some time to think about it.',
    'Da, zanima nas.',
    'Zanima nas, ali tek iduće godine.',
    'Ispričajte me na trenutak.',
    'Recite mi kad ste spremni.',
    'Tell me once you are done.',
    'Show me tomorrow.',
    'We need to understand the budget first, then we will come back to you.',
    'Oh, tell me about it.',
    'Tell me about it, ours was a nightmare too.',
    "Yeah, I'm curious about that too."
  ]) {
    assert.equal(needsReply(text), false, text)
  }
  assert.equal(isSmallTalk('Luka, can you hear me?'), true, 'said to someone by name, still small talk')
})

test('who a turn speaks to: introductions, speakers among the names, lists and call-outs', async () => {
  const { addressedTo } = await import('./.build/togle.mjs')
  const to = (text, names = ['Luka', 'Luke']) => addressedTo(text, names)
  // Said about, not to.
  for (const text of [
    'Ana, our CFO, has a question: how do you handle VAT?',
    'Ana, naša direktorica financija, ima pitanje: kako rješavate PDV?',
    'Marko, Ana and I reviewed your proposal. Does it include onboarding?',
    'Marko, Ana i ja smo pogledali ponudu. Uključuje li onboarding?',
    'Luka said we can ship in March, is that still the plan?',
    'Luka mentioned the export is slow, is that right?'
  ]) {
    assert.equal(to(text), undefined, text)
  }
  // Words a sentence opens with, that a name happens to be too.
  for (const text of ['Jasno. A koliko to košta?', 'Rok, kad bi to bilo gotovo?', 'Mira, ¿cuánto cuesta?', 'Sydney, do you have a region there?', 'Mate, how long does the setup take?']) {
    assert.equal(to(text), undefined, text)
  }
  for (const text of [
    'Ana, Marko, and Luka, what do you three think?',
    'What do you think, Ana, Marko, and Luka?',
    'Hi Ana, hi Luka, what do you think about the proposal?',
    'Marko or Luka, who owns the export?',
    'Question for Luka: how do you handle refunds?'
  ]) {
    assert.equal(to(text), 'me', text)
  }
  assert.equal(to('Ivice, što misliš o tome?', ['Ivica']), 'me')
  assert.equal(to('Mr Dutina, what do you think?', ['Luka Dutina']), 'me')
  assert.equal(to('Ana-Marija, what do you think?', ['Ana-Marija']), 'me')
  for (const text of [
    'Could you share your screen, Marko?',
    'Mirko, can you share the numbers?',
    'Herr Müller, können Sie die Zahlen teilen?',
    'Okay. Marko? Can you share the numbers?',
    'Ana-Marija, what do you think?'
  ]) {
    assert.equal(to(text), 'other', text)
  }
})

test('the strong model starts on an HTTP error however it is said, not on amounts or a bug bounty', async () => {
  const { looksDeep } = await import('./.build/togle.mjs')
  for (const q of ['Javlja se pogreška 500 na checkoutu, što biste provjerili?', 'Dobivamo error 500 na checkoutu, što biste provjerili?', "We're getting a 500 error on checkout, where would you start?"]) {
    assert.equal(looksDeep(q), 'strong', q)
  }
  for (const q of ['Imamo grešku 400 tisuća kuna u bilanci, kako?', 'Greška 500 000 eura u ponudi?', 'Do you have a bug bounty program?', 'Can you give me a crash  course on pricing?', 'We have 400 errors in the report, is that normal?']) {
    assert.equal(looksDeep(q), undefined, q)
  }
})

test('what I said to the agent lately is read newest first, up to its size, by day; nothing when I said nothing', async () => {
  const { talkText } = await import('./.build/togle.mjs')
  const now = Date.parse('2026-10-27T09:12:00')
  const said = (text, ago) => ({ role: 'user', text, at: now - ago })
  // Only calls and the agent's own words: nothing of mine to go by.
  assert.equal(talkText([{ role: 'call', at: now - 3_600_000, endedAt: now - 1_800_000 }, { role: 'agent', text: 'Hello!', at: now - 60_000 }], now), '')
  // More than fits: the newest, oldest first.
  const text = talkText(Array.from({ length: 10 }, (_, i) => said(`${i} ${'y'.repeat(1400)}`, (10 - i) * 60_000)), now)
  assert.ok(text.length <= 6_000, `${text.length} characters`)
  assert.match(text, /^Me \(today \d\d:\d\d\): 6 y+\n/)
  assert.match(text, /\nMe \(today \d\d:\d\d\): 9 y+$/)
  // Yesterday by name, a day before that by its date.
  assert.match(talkText([said('the first', 2 * 86_400_000), said('the second', 86_400_000)], now), /^Me \(Sun, Oct 25, \d\d:\d\d\): the first\nMe \(yesterday \d\d:\d\d\): the second$/)
})

test('what I wrote to the agent during a call says so: during that call, or during this one', async () => {
  const { talkText } = await import('./.build/togle.mjs')
  const now = Date.parse('2026-10-27T11:00:00')
  const min = 60_000
  const text = talkText(
    [
      { role: 'user', text: 'For the Globex call: 10% at most.', at: now - 120 * min },
      { role: 'call', at: now - 60 * min, endedAt: now - 30 * min },
      { role: 'user', text: "Don't give them dates for the deploy.", at: now - 45 * min },
      { role: 'agent', text: 'Got it: no dates.', at: now - 44 * min },
      { role: 'user', text: 'Standup at 11.', at: now - 20 * min },
      { role: 'call', at: now - 5 * min },
      { role: 'user', text: 'Keep it short today.', at: now - 2 * min }
    ],
    now
  )
  assert.match(text, /^Me \(today 09:00\): For the Globex call/)
  assert.match(text, /\nMe \(today 10:15, during that call\): Don't give them dates for the deploy\.\nYou \(today 10:16, during that call\): Got it: no dates\./)
  assert.match(text, /\nMe \(today 10:40\): Standup at 11\./)
  assert.match(text, /\nMe \(today 10:58, during this call\): Keep it short today\.$/)
})

test('written to the agent in a pause of a call (Stop, then Start a moment later), it was written during that call', async () => {
  const { talkOf, talkText } = await import('./.build/togle.mjs')
  const now = Date.parse('2026-10-27T11:00:00')
  const min = 60_000
  // As the window keeps it: the call's stretch, my message and its reply, the stretch of the same call going on.
  const entries = [
    { id: 'c1', role: 'call', call: 'k1', startedAt: now - 30 * min, endedAt: now - 12 * min, cards: [] },
    { id: 'u1', role: 'user', text: "Don't give them any dates.", at: now - 11 * min },
    { id: 'a1', role: 'agent', text: 'Got it: no dates on this call.', changes: [], at: now - 11 * min + 5000, status: 'done' },
    { id: 'c2', role: 'call', call: 'k1', startedAt: now - 10 * min, cards: [], resumed: true }
  ]
  const turns = talkOf(entries)
  assert.deepEqual(
    turns.map((t) => t.role),
    ['call', 'user', 'agent'],
    'one call'
  )
  assert.match(talkText(turns, now), /\nMe \(today 10:49, during this call\): Don't give them any dates\.\nYou \(today 10:49, during this call\): Got it/)
})

test('from before the newest of it, what I said that bears on the call comes back too, with its reply', async () => {
  const { talkFor } = await import('./.build/togle.mjs')
  const now = Date.parse('2026-10-27T11:00:00')
  const day = 86_400_000
  const turns = [
    { role: 'user', text: 'For the Initech renewal: 5% off at most.', at: now - 6 * day },
    { role: 'agent', text: 'Noted for Initech.', at: now - 6 * day + 60_000 },
    { role: 'user', text: 'For the Hooli call: push the integration.', at: now - 5 * day },
    // A week of pasting since: more than the newest part holds.
    ...Array.from({ length: 6 }, (_, i) => ({ role: 'user', text: `A pasted log ${i}: ${'z'.repeat(1400)}`, at: now - (4 - i * 0.5) * day }))
  ]
  const bears = (text) => text.includes('Initech')
  const { recent, about } = talkFor(turns, now, bears)
  assert.doesNotMatch(recent, /Initech|Hooli/, 'the newest part is the pasting')
  // (Clocks went back on Oct 25 in Europe: by the time of day, six days earlier can be an hour off.)
  assert.match(about, /^Me \(Wed, Oct 21, \d\d:\d\d\): For the Initech renewal: 5% off at most\.\nYou \(Wed, Oct 21, \d\d:\d\d\): Noted for Initech\.$/)
  assert.equal(talkFor(turns, now).about, '', 'nothing without a call to bear on')
  // Older than a month, it isn't looked for.
  assert.equal(talkFor([{ ...turns[0], at: now - 31 * day }, ...turns.slice(2)], now, bears).about, '')
})
