// Test calls. Each one is the call so far, then what Togle is asked to do; `expect` says what a good answer does.
const { agentFor } = require('./data.cjs')

module.exports.selective = require('./selective-cases.cjs')

module.exports.general = [
  {
    id: 'G1',
    title: 'Sales, product unknown: price and annual discount',
    lines: [
      ['them', 'Thanks for making the time today.'],
      ['me', 'Of course, happy to.'],
      ['them', 'So, how much would your platform cost for a team of forty, and do you give a discount if we pay annually?']
    ],
    expect: 'Answers both parts without inventing prices or discounts (placeholders or an honest follow-up), sayable.'
  },
  {
    id: 'G2',
    title: 'Behavioural interview question',
    lines: [
      ['them', "Thanks for coming in. I've read your CV."],
      ['them', 'Can you tell me about a time you disagreed with a teammate and how you handled it?']
    ],
    expect: 'A first-person answer I can say, structured (situation, what I did, result), without inventing my history.'
  },
  {
    id: 'G3',
    title: 'Concept question',
    lines: [['them', "Quick one before we go deeper: what's the difference between a process and a thread?"]],
    expect: 'Correct and short: own memory vs shared memory, cost of switching and creating, isolation.'
  },
  {
    id: 'G4',
    title: 'System design',
    lines: [
      ['them', "Let's do a design exercise."],
      ['them', 'How would you design a rate limiter for an API that serves fifty thousand requests per second across three regions?']
    ],
    expect: 'Quick: a framing to start talking. Deep: algorithm, where counters live, regional vs global limits, failure modes, numbers.'
  },
  {
    id: 'G5',
    title: 'Answer depends on what was said before',
    lines: [
      ['them', "We're choosing between hosting on AWS or on Hetzner."],
      ['me', 'Right, AWS costs more but has managed databases and queues.'],
      ['them', 'Exactly. With a team of only three engineers, which one would you pick?']
    ],
    expect: 'Picks one and ties it to the three-person team and the managed services just mentioned.'
  },
  {
    id: 'G6',
    title: 'Two questions in one',
    lines: [
      ['them', "Great, we'd like to move forward."],
      ['them', 'Two quick things: when could you start, and would you be okay coming into the Berlin office twice a week?']
    ],
    expect: 'Answers both, with a placeholder for the start date; no invented commitments.'
  },
  {
    id: 'G7',
    title: 'Recall a decision from earlier in the call',
    lines: [
      ['them', 'Okay, so we agree the launch moves to March fifteenth.'],
      ['them', 'And Ana owns the QA plan, Marko the release notes.'],
      ['me', 'Sounds good.'],
      ['them', 'Alright, next topic, the hiring plan for Q2.'],
      ['them', 'We need two backend engineers and one designer.'],
      ['me', "I'll draft the job posts."],
      ['them', 'Sorry, I dropped for a minute. What did we decide about the launch?']
    ],
    expect: 'Launch moved to March 15; Ana owns QA, Marko the release notes. Nothing else.'
  },
  {
    id: 'G8',
    title: 'Question in Croatian',
    lines: [
      ['them', 'Dobar dan, hvala što ste se javili.'],
      ['them', 'Možete li mi ukratko objasniti kako vaš sustav radi sa SAP-om?']
    ],
    expect: 'Replies in Croatian; does not invent how the integration works.'
  },
  {
    id: 'G9',
    title: 'Small talk',
    lines: [
      ['them', 'Hi! Can you hear me okay?'],
      ['me', 'Yes, loud and clear.'],
      ['them', 'Great. How was your weekend?']
    ],
    request: { kind: 'suggest' },
    expect: 'A short, friendly reply. No deep answer.'
  },
  {
    id: 'G10',
    title: 'Production debugging',
    lines: [
      ['them', 'We have a production issue.'],
      ['them', "Our Node service's memory keeps climbing until it crashes every few hours. Where would you start?"]
    ],
    expect: 'Quick: where to start. Deep: heap snapshots compared over time, common leak sources, confirming the fix, mitigation meanwhile.'
  },
  {
    id: 'G11',
    title: 'Price objection, no product facts',
    lines: [['them', "I'll be honest, this sounds more expensive than what we use now."]],
    expect: 'Acknowledges, asks what they compare with or pay now, frames value; invents no numbers.'
  },
  {
    id: 'G12',
    title: 'The brief says what the call is for',
    brief: "Discovery call with Northwind's head of support. I want to book a two-week pilot with their support team.",
    lines: [
      ['them', "Thanks, we've seen enough of the demo."],
      ['them', 'So what would you suggest as a next step?']
    ],
    expect: 'Proposes the two-week pilot with the support team, from the brief; invents no dates or prices.'
  }
]

module.exports.acme = [
  {
    id: 'A1',
    title: 'Price for 40 users, and SSO',
    lines: [
      ['them', 'Thanks for the demo, it looks good.'],
      ['them', "We'd be about forty users. What would Growth cost us per month, and is SSO included?"]
    ],
    expect: '€1,560 a month (40 × €39); SSO only on Enterprise. Cites the pricing document.'
  },
  {
    id: 'A2',
    title: 'Approved answer',
    lines: [['them', 'Does it work with SAP?']],
    expect: 'The approved answer shows at once (partner connector, €500 a month, about a week to set up), and no model is asked: it is all they asked.'
  },
  {
    id: 'A3',
    title: 'Objection, with a skill for it',
    lines: [['them', 'Honestly, this is more expensive than the tool we use now.']],
    expect: 'Follows the skill: asks what they compare with and pay today; mentions value / 2 months free yearly; no discount.'
  },
  {
    id: 'A4',
    title: 'Two facts from two documents',
    lines: [['them', 'Where would our data be stored, and can we try it before we buy?']],
    expect: 'AWS Frankfurt (EU); 14-day free trial, no credit card.'
  },
  {
    id: 'A5',
    title: 'Not in the documents',
    lines: [['them', 'Do you have an on-premise version we could run in our own data center?']],
    expect: 'Does not claim one exists; says it is cloud-hosted in Frankfurt and offers to check, or a placeholder.'
  },
  {
    id: 'A6',
    title: 'Yearly price for the same seats',
    lines: [
      ['them', "We'd be about forty users on Growth."],
      ['me', 'That would be 1,560 euros a month.'],
      ['them', 'And if we paid yearly for those forty seats, what would the whole year cost?']
    ],
    expect: '€15,600 a year (2 months free: 40 × €39 × 10).'
  }
]

const PRICING = `# Acme Analytics pricing (2026)

## Plans
- Starter: €19 per user per month. For teams of 1 to 10 users. Up to 5 dashboards, email support.
- Growth: €39 per user per month. Unlimited dashboards, all standard integrations (Salesforce, HubSpot, Slack, Microsoft Teams, Google Sheets), scheduled reports, priority support.
- Enterprise: custom pricing, from 100 users. Everything in Growth plus SAML single sign-on (SSO), SCIM user provisioning, audit logs, a dedicated customer success manager and a 99.9% uptime SLA.

## Billing
- Monthly or annual billing. Annual billing gives 2 months free: you pay for 10 months.
- Prices are in euros and exclude VAT.
- Seats can be added at any time and are prorated.

## Add-ons
- SAP connector, built by our partner Nordlink: €500 per month on top of any plan. Setup takes about one week.
- Extended data retention beyond 24 months: €2 per user per month.

## Trial
- 14-day free trial of the Growth plan. No credit card needed.

## Discounts
- Nonprofits and education: 30% off list price, on request.
- We don't give other discounts; larger deals go through the account manager.`

const SECURITY = `# Security and compliance

- Hosting: all customer data is stored in AWS Frankfurt (eu-central-1). Backups stay in the EU (AWS Ireland).
- Certifications: ISO 27001 certified since 2024. SOC 2 Type II report available under NDA.
- GDPR: we sign a Data Processing Agreement (DPA) with every customer. Subprocessors are listed on our trust page.
- Encryption: AES-256 at rest, TLS 1.2 or newer in transit.
- Access: SAML SSO and SCIM are available on the Enterprise plan only. All plans support two-factor authentication.
- Data retention: 24 months by default; extended retention is a paid add-on. Customers can export or delete their data at any time.
- Penetration tests: yearly, by an external firm; a summary is available under NDA.`

const ONBOARDING = `# Onboarding and support

- Typical setup: one to two weeks, depending on the number of integrations.
- Growth customers get two onboarding calls with a solutions engineer.
- Enterprise customers get a dedicated customer success manager and a 30-day rollout plan.
- Support hours: Monday to Friday, 8:00 to 18:00 CET, by email and chat.
- Enterprise: 24/7 phone support for priority 1 incidents.
- Response targets: priority 1 within 1 hour, priority 2 within 4 business hours, other requests within 1 business day.
- Training: free live webinars every week, and recorded courses in the help center.`

const FAQ = `# Product FAQ

## What is Acme Analytics?
A reporting platform that pulls data from CRM, finance and support tools into live dashboards, so teams stop building reports by hand.

## Which data sources can we connect?
Salesforce, HubSpot, Pipedrive, Stripe, QuickBooks, Xero, Google Sheets, PostgreSQL, MySQL, BigQuery, Snowflake, and CSV upload.

## Where do alerts and reports go?
Slack, Microsoft Teams, and email. Reports can be scheduled daily, weekly or monthly.

## How fresh is the data?
Starter refreshes every hour, Growth every 15 minutes, Enterprise every 5 minutes.

## Can we export?
Yes: CSV, Excel and PDF, from any dashboard.

## Is there an API?
A REST API with 600 requests per minute per workspace, and webhooks for alerts.

## Mobile apps?
iOS and Android apps to view dashboards and get alerts.

## Which languages does the app support?
English, German, French and Croatian.

## Roles
Admin, Editor and Viewer. Every user needs a seat on their plan.

## Custom metrics
A formula editor on every plan; SQL mode on Growth and Enterprise.

## Limits
Starter: 5 dashboards and 5 million rows per data source. Growth and Enterprise: unlimited dashboards; 50 million rows per source on Growth, 500 million on Enterprise.

## Contracts and payment
Monthly plans can be cancelled at any time. Annual plans renew every year and can be cancelled up to 30 days before renewal. Payment by card, or by invoice for annual plans.`

/** The trained agent: made once in the copied data, then reused. */
module.exports.acmeAgent = async (store) => {
  const existing = store.list().find((a) => a.name === 'Acme sales (eval)')
  if (existing) return existing
  const agent = await agentFor(store, 'sales')
  await store.update(agent.id, { name: 'Acme sales (eval)', aboutMe: "I'm an account executive at Acme Analytics." })
  for (const [name, text] of [
    ['Pricing and plans', PRICING],
    ['Security and compliance', SECURITY],
    ['Onboarding and support', ONBOARDING],
    ['Product FAQ', FAQ]
  ]) {
    await store.addText(agent.id, name, text)
  }
  await store.addAnswer(
    agent.id,
    'Do you integrate with SAP?',
    "Yes, through our partner Nordlink's SAP connector. It's 500 euros a month on top of your plan, and setup takes about a week.",
    'manual'
  )
  await store.saveSkill(
    agent.id,
    {
      name: 'Pricing objections',
      when: "They say we're too expensive, or compare us with a cheaper tool",
      how: "- First ask what they're comparing us with, and what it costs them today.\n- Then show the value: time saved on reporting, and the annual plan's 2 months free.\n- Never offer a discount yourself; for big deals, offer to bring in the account manager."
    },
    'manual'
  )
  return store.list().find((a) => a.id === agent.id)
}
