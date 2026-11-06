# Togle agents

Agents for Togle, the AI assistant for video calls, for every kind of call: teaching, a clinic's front desk, podcast interviews, sales, one-on-ones. Each folder under `agents/` is one agent, ready to install and then to teach on your own calls. Togle comes with these, as its market's own agents; published as a GitHub repository, this is a hub that lists more.

## Install one

In Togle: **Agents → Market**. Add this hub by its name (`owner/repo`) under **More sources** if it isn't listed, pick an agent, look at what it adds, and **Install**. Togle checks every agent before showing it (instructions that try to take over the model, send a call somewhere, or ask for passwords or payments are refused), and installs it as a new agent of your own: what it learns on your calls stays on your PC.

## Publish yours

In Togle, open your agent and press **Share**, then **Publish to** this hub. Togle writes the agent's folder (its setup, skills and approved answers, and only the memory facts and documents you ticked; never About me, its calls or its history) and opens this repository's page for adding files. Drag the folder's files onto that page and propose the change: GitHub makes a pull request, and the hub's keepers review it. Once it's merged, `index.json` is rebuilt and the agent shows in Togle.

## What's in an agent

```
agents/clinic-front-desk/
├── AGENT.md                    # its setup: name, description, author, words to recognize; its instructions below
├── skills/
│   └── booking/SKILL.md        # one per skill, in the open agentskills.io format
├── answers.md                  # approved answers: "## question", then the answer (optional)
├── memory.md                   # facts it relies on, "- fact" (optional)
├── knowledge/price-list.md     # documents it looks things up in (optional)
└── README.md                   # shown on GitHub; Togle doesn't read it
```

`AGENT.md`:

```markdown
---
name: Clinic front desk
description: Patient calls at a dental clinic
author: Ana
format: togle-agent/1
tags: [Health]
vocabulary: Invisalign, periodontist
---

- Book, move and cancel appointments; read back the date and time.
```

`tags` puts it in a category of Togle's market (one is enough: Business, Work, Health, Teaching, Career, Media, or a new one).

A skill is a [SKILL.md](https://agentskills.io/specification): `name` (its folder's name: lowercase letters, digits and hyphens), `description` (what it does and when to use it), and the rules below it. Togle keeps its own name for the skill and when it applies in `metadata` (`togle-name`, `togle-when`); a skill written for Hermes Agent or Claude installs too, named after its folder. Only Markdown and text files are read, and nothing in an agent is ever run.

## For the keepers: reviewing a pull request

The **Check agents** workflow runs `node scripts/build-index.mjs --check` on every pull request: each agent needs an `AGENT.md` with a name, Markdown and text files only, within Togle's sizes, skill folders named as agentskills.io asks, and no text hidden from a reviewer (characters that show text in another order than it's read, invisible tag characters, or an HTML comment outside a document). Then read it as someone who'll use it on a call would:

- **No one's private data:** customers' names and details, phone numbers, prices or terms a business gave one customer.
- **Instructions that fit what it says it's for,** and nothing that steers people somewhere they didn't ask to go: links, numbers and addresses should be the publisher's own and plain to see.
- **Skills are rules with their reasons,** not a story of one call.
- **Documents its author may share.**

After a merge to `main`, the **Build the index** workflow runs `node scripts/build-index.mjs` and commits `index.json`, which Togle reads.
