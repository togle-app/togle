// Fictional calls. Facts, decisions and recovery behavior are machine-checked.
const pricing = ['Pricing', 'Growth costs 29 euros per user per month. SSO is available only on Enterprise. No discounts are approved.']
const webhooks = ['Webhook guide', 'Webhooks are retried 5 times over 24 hours. Consumers must deduplicate by event ID and make processing idempotent.']

module.exports = [
  {
    id: 'R1', title: 'Sales: team price and the right plan',
    knowledge: [pricing],
    lines: [
      ['them', 'We are a team of eight and are looking at Growth.'],
      ['me', 'I see.'],
      ['them', 'What would that cost each month, and can we use SSO on Growth?']
    ],
    decision: 'shown',
    prompt: [/29 euros/, /Enterprise/],
    require: [['correct team price', /\b232\b/], ['SSO plan restriction', /Enterprise/i]],
    forbid: [['unapproved discount', /\b(?:offer|give|apply)\b[^.!?\n]{0,30}\b(?:10|15|20)\s*%/i]],
    offline: 'LEVEL: quick\nFor eight people, Growth is 232 euros per month. SSO requires Enterprise.'
  },
  {
    id: 'R2', title: 'Support: retries and duplicate webhook events',
    knowledge: [webhooks],
    lines: [
      ['them', 'Our network dropped yesterday and now we are receiving the same webhook more than once.'],
      ['me', 'Got it.'],
      ['them', 'How many times do you retry, and how do we avoid processing an event twice?']
    ],
    decision: 'shown',
    prompt: [/5 times/, /24 hours/],
    require: [['retry count', /\b(?:5|five)\b/i], ['retry window', /\b(?:24|twenty.four)\b/i], ['deduplication', /idempot|deduplic|event.?id/i]],
    offline: 'LEVEL: quick\nWe retry five times over 24 hours. Deduplicate by event ID and make the handler idempotent.'
  },
  {
    id: 'R3', title: 'Private fact: revenue was never provided',
    lines: [['them', 'What is your current annual recurring revenue?']],
    decision: 'shown',
    require: [['addresses the missing fact', /ARR|revenue|confirm|check|\[[^\]]+\]/i]],
    forbid: [['invented revenue', /[$€£]\s*\d|\b\d[\d,.]*\s*(?:euros?|dollars?|million|billion|USD|EUR)\b/i]],
    offline: 'LEVEL: quick\nOur annual recurring revenue is [ARR].'
  },
  {
    id: 'R4', title: 'Group meeting: Marko is being asked',
    group: true, noRequest: true,
    brief: 'I am Luka. Marko owns deployment; I own product.',
    lines: [['me', 'Marko will cover deployment.'], ['them', 'Marko, when can you deploy the new version?']],
    decision: 'quiet',
    offline: 'LEVEL: quiet'
  },
  {
    id: 'R5', title: 'Scheduling: I answered before the suggestion started',
    noRequest: true,
    lines: [['them', 'Which day works for your team?'], ['me', 'Tuesday works for our team.']],
    decision: 'quiet',
    offline: 'LEVEL: quiet'
  },
  {
    id: 'R6', title: 'Presentation: a self-answered question',
    lines: [['them', 'Where is the export button? Oh, I found it in the top right. No need to explain; let me show the next slide.']],
    decision: 'quiet',
    offline: 'LEVEL: quiet'
  },
  {
    id: 'R7', title: 'Croatian: a quote grounded in English documents',
    knowledge: [pricing],
    lines: [['them', 'Koliko bi Growth koštao za četiri korisnika mjesečno?']],
    decision: 'shown',
    prompt: [/29 euros/],
    require: [['correct team price', /\b116\b/], ['reply in the call language', /korisni|mjese|mese|eura|eur[oa]/i]],
    offline: 'LEVEL: quick\nZa četiri korisnika Growth košta 116 eura mjesečno.'
  },
  {
    id: 'R8', title: 'After the call: action owner and agreed deadline',
    brief: 'I am Luka. This call is with Ana at Northwind.',
    lines: [
      ['them', 'Before we can start a pilot, we need to review your SOC 2 report.'],
      ['me', 'I will send the SOC 2 report by Tuesday.'],
      ['them', 'Thanks, Luka. I will review it with our security team on Wednesday.']
    ],
    request: { kind: 'summary' }, decision: 'shown',
    require: [['the promised document', /SOC.?2/i], ['the agreed deadline', /Tuesday/i], ['an action owner', /Luka|\bMe\b|\bYou\b/i]],
    offline: '## Action items\n- Luka: send the SOC 2 report by Tuesday.\n- Ana: review it with security on Wednesday.'
  },
  {
    id: 'R9', title: 'Service limit: automatic pause and manual recovery',
    recovery: true, knowledge: [webhooks], expectedErrors: 1,
    lines: [['them', 'How many times are webhooks retried?'], ['them', 'And how should we handle duplicate events?']],
    decision: 'shown',
    prompt: [/event ID/],
    require: [['useful recovery answer', /idempot|deduplic|event.?id/i]],
    offline: 'LEVEL: quick\nDeduplicate by event ID and make processing idempotent.'
  }
]
