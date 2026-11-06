# AI presets and agent settings

Recipe version: `2026-11-03-v1`.

Accounts is the shared connection library: Claude subscriptions, ChatGPT accounts (Sign in with ChatGPT), named Anthropic APIs, compatible APIs, and local model servers. API connections keep independent encrypted keys. Adding a connection does not select it as the default. A server or credential change invalidates pinned requests; changing a server origin requires entering or explicitly clearing its key.

## The three recipes

| Task | Claude | ChatGPT | Mixed |
| --- | --- | --- | --- |
| Quick answers | Sonnet 5.5 · low | GPT-6-Luna · low | GPT-6-Luna · low |
| Deep answers, code and learning | Opus 5.5 · high | GPT-6.1-Sol · medium | Opus 5.5 · high |
| Screen reading | Opus 5.5 · low | GPT-6.1-Sol · low | GPT-6.1-Sol · low |
| Background work | Haiku 5.5 · low | GPT-6-Luna · low | GPT-6-Luna · low |

Each recipe saves four actual account/model routes together. Accounts for presets lets users choose work or personal subscriptions without configuring every task again. An unavailable preferred profile prevents applying its recipe; it never silently becomes another signed-in profile. Customize task models also accepts configured APIs and local models. Named connections do not act as automatic subscription-limit fallbacks.

Claude's catalog supplies pinned full IDs (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) alongside rolling aliases. Saved recipes use full IDs. Current selections remain saved when catalogs change; applying a recipe is explicit. Model family selection uses the account's available catalog, not a claim that every account has identical entitlements.

The selections follow the providers' [model selection guidance](https://developers.openai.com/api/docs/guides/model-selection), [Claude comparison](https://platform.claude.com/docs/en/models/overview), and [full model ID configuration](https://code.claude.com/docs/en/model-config). They are Togle's evaluated starting recipes, not a universal ranking of every model.

Call learning reviews use the deep route to reason about durable facts and skills. Routine running notes and extraction retain the background route. Learning remains outside the live-answer path; this does not add another model setting.

## Scope and inheritance

General settings owns connected accounts, default AI, speech and voice typing preferences. An agent's Settings tab has independent inheritance switches for AI, speech, and voice typing. Enabled overrides use the same controls as General. Restoring one section preserves the others. Knowledge and Learning have separate tabs.

F9 uses the selected agent's speech/voice preferences outside calls and the owning agent's preferences during a call. A recording snapshots its account, microphone, language and cleanup preferences. Changing pages or preferences does not reroute an existing recording. Shortcut keys themselves remain shared across agents.

A call snapshots all four AI routes and its speech configuration. Existing calls retain those snapshots after default or agent edits. Each authenticated connection enforces identity pinning. A plan limit on one task's account does not incorrectly mark another provider's task as limited. Saved-call reviews and notes use the recorded task routes.

Meeting reminders live only in agent Settings. Enabling reminders requires choosing that agent's Claude calendar account. Events, alerts and dismissals carry the owning agent's ID. Starting from a reminder selects that owner; browsing another agent cannot redirect it. Calendar reads use the selected Claude connection and pause during active calls. Existing General reminders migrate to their previously selected agent and account.

## Validation

`npm run test:presets:live` sends fictional content through the signed-in subscriptions. It performs at most eight distinct task requests, reusing identical combinations between recipes. It does not capture devices, read real meetings or documents, change settings, or use API billing.

On November 3, 2026, all eight checks passed using the pinned IDs above: a concise trial/SSO reply, an OAuth release decision with named owners and deadlines, exact values/difference/total from a synthetic chart, and action items without inventing an FAQ owner. Sample times below are a single run per combination, rather than latency guarantees or a comprehensive benchmark.

| Task | Claude: first text / complete | ChatGPT: first text / complete |
| --- | --- | --- |
| Quick | 2.32 s / 4.51 s | 1.33 s / 1.51 s |
| Deep | 2.83 s / 5.52 s | 2.37 s / 3.33 s |
| Screen | 3.79 s / 5.87 s | 2.76 s / 2.89 s |
| Background | 2.50 s / 4.78 s | 1.24 s / 1.68 s |

The local result is `test/.work/presets-live/result.json`; it contains only fictional fixture responses and provider/model metadata. Automated tests cover task dispatch, route snapshots, missing profiles, connection-key isolation, preference resets, per-agent calendars, OS-encrypted API keys through real IPC, selected-agent F9 mode, active-call precedence, and compact/wide layouts.
