// Fictional call moments for checking automatic silence without losing useful help.
// These are shared by the real-model evaluation and can be replayed with any provider.
module.exports = [
  {
    id: 'Q1', title: 'Rhetorical question',
    lines: [['them', "Who doesn't want fewer outages? That's why we built this dashboard. Let me show you the next slide."]],
    decision: 'quiet',
    expect: 'No suggestion: the question is rhetorical and the speaker is presenting.'
  },
  {
    id: 'Q2', title: 'Speaker answers their own question',
    lines: [['them', 'What does it cost? The annual plan is 249 euros. That answers the pricing question; I will explain support next.']],
    decision: 'quiet',
    expect: 'No suggestion: the speaker supplied their own answer and is moving on.'
  },
  {
    id: 'Q3', title: 'Question explicitly addressed to someone else',
    brief: 'I am Luka. Marko is another participant; he owns the deployment.',
    lines: [['them', 'Marko, which day can you deploy? We need your answer, Marko.']],
    decision: 'quiet',
    expect: 'No suggestion for Luka: Marko was explicitly asked.'
  },
  {
    id: 'Q4', title: 'Answered question and conversation moved on',
    lines: [
      ['them', 'Which day works for your team?'],
      ['me', 'Tuesday works for our team.'],
      ['them', 'Great, Tuesday it is. I will send the invitation. Moving on to the next agenda item.']
    ],
    decision: 'quiet',
    expect: 'No suggestion: the user answered and the caller accepted it.'
  },
  {
    id: 'Q5', title: 'Real unanswered question',
    lines: [['them', 'What is the difference between authentication and authorization?']],
    decision: 'shown',
    expect: 'A short, correct reply about identity versus permitted access.'
  },
  {
    id: 'Q6', title: 'Missing personal fact still needs a reply',
    lines: [['them', 'When does your current contract renew?']],
    decision: 'shown',
    expect: 'A sayable reply that leaves the unknown date open, without inventing it or staying silent.'
  },
  {
    id: 'Q7', title: 'Acknowledgement leaves the question open',
    lines: [
      ['them', 'Could you explain the difference between authentication and authorization?'],
      ['me', 'I see.']
    ],
    decision: 'shown',
    expect: 'Still answers the question: I see is a listening cue, not the explanation.'
  },
  {
    id: 'Q8', title: 'Unanswered question in Croatian',
    lines: [['them', 'Koja je razlika između autentikacije i autorizacije?']],
    decision: 'shown',
    expect: 'A short, correct answer in Croatian.'
  }
]
