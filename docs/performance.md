# Performance checks

Run `npm run perf:app` to build Togle and exercise its production renderer with fictional data and real OS encryption. It uses an isolated profile under `test/.work/perf/`; it does not use accounts, microphones or model requests. Results go to `test/.work/perf/latest.json`.

The scenario stores 61 calls, including a 20,000-line call with 200 replies. It measures cold history listing, repeated call inspection, saves, renderer startup, transcript opening and transcript search. It also verifies that searching finds the final line, incremental loading reveals more lines and replies, export includes the whole call, and another call's updates do not reload the open record. Timing results are descriptive; assertions constrain work and preserve content without brittle machine-specific deadlines.

Measured on the development Windows PC on 2026-10-29:

| Operation | Before | After |
| --- | ---: | ---: |
| Open the long transcript | 1,584 ms | 34 ms |
| Inspect the same saved call, median | 9.40 ms | 2.91 ms |
| Save the long call, median | 54.34 ms | 32.44 ms |
| Decryptions across 12 inspections | 12 | 1 |
| Initial transcript DOM rows | 20,000 | 100 |

These numbers measure local application work. They do not measure speech recognition or provider response time. `npm run perf -- --days 7` reports actual call timings when calls have been made; it logs timings and token counts without call text.

## Live call measurements — October 30, 2026

The live path now counts silence already spent detecting and transcribing a completed question, removing a second 300 ms wait. Uncertain pauses keep their longer debounce. Knowledge, earlier calls and chat are loaded concurrently; instant facts and prompt preparation share one chat read per question. Quick replies no longer wait for a repository scan that only the deeper answer can use. Full grounding remains available.

| Measurement on this Windows PC | Before | After |
| --- | ---: | ---: |
| Completed transcript to provider invocation, median of three recorded questions | 313 ms | 2 ms |
| Last word to first reply event, real Whisper with the same fixed 400 ms model response | 1,471 ms | 1,181 ms |
| Open the current 20,000-line transcript in the production renderer | 660 ms | 27 ms |
| Initial current-transcript DOM rows | 20,000 | 100 |

The controlled audio comparison uses the production Segmenter, real Whisper on GPU, hearing pipeline and Copilot. Its fixed model isolates local latency; it does **not** measure a faster AI service. The transcript test includes paint time. Updates were already about 33–35 ms including two animation frames, so this change improves opening and bounds rendering work rather than claiming a measured per-caption speedup.

A separate run used the same recorded questions with the official Claude subscription SDK, Haiku at low effort. All three answers retained the supplied SSO, hosting-location and trial-length facts. First reply events arrived in 3,773 / 3,432 / 3,520 ms from speech (median 3,520 ms); this includes speech recognition and the provider, but not renderer paint or a screen lookup. These are three development observations, not a latency guarantee or a comparison with the user's configured model. Quick replies cite inline without a second Facts section; their reference notes remain expandable in the UI.

Run `npm run perf:call` for the recorded-audio check with a fixed model, or `npm run perf:call -- --live` for up to three Claude subscription requests. Both use a new isolated profile, fictional content, and no microphone or screen capture. They require installed local Whisper and `eval/audio/q2.wav`, `q3.wav`, `q4.wav` (on Windows, generate the fixtures with `powershell -NoProfile -File eval/voices.ps1`). No model or speech installation is performed by the benchmark. Reports are written under `test/.work/live-assist/`; the live report includes only the fictional answers.

Actual call logs now distinguish reply scheduling, local preparation and provider first text. Older records lack the new `providerStarted` field and are excluded from that breakdown. `npm run perf:app` also checks current-transcript pagination; the UI suite checks a running 2,000-line call, partial captions, typing, scrolling back and returning to the latest speech.

## Work bounds

- History renders 100 calls, 100 transcript lines or 25 suggestions initially, then reveals more on demand. Search and export still use the complete saved record. Transcript search is deferred so typing can render first; timestamps share one formatter.
- The repository keeps up to four decrypted JSON records with a combined 16 MiB text budget. Evicted records remain encrypted on disk. Each inspection parses an independent value, so renderer changes cannot mutate cached content. Reads and writes serialize, and deletion evicts cached content.
- Capture snapshots copy only the content retained by history, rather than screen frames and nested live UI state. The encrypted write and cache share one JSON serialization. File sync and atomic replacement remain enabled.
- Concurrent history consumers share one list snapshot and recovery flush. Legacy summary deduplication uses sets rather than repeatedly scanning the saved list.
- Inspecting one call ignores notifications for other calls. An unchanged learning revision preserves the existing chat state, preventing redundant conversation saves.
- The current transcript initially renders the newest 100 entries. Captions merge only with that visible tail; Show earlier transcript reveals another 100. Reading earlier lines keeps the first visible entry and scroll position while new speech arrives. Returning to the bottom releases the earlier rendered rows. The complete transcript stays in memory and history.

`npm test`, `npm run test:ui` and `npm run test:native` cover data isolation, snapshot ownership, cache eviction, failed writes, interrupted learning, approvals, rename/export/delete, older-call access and concurrent history consumers.

## Assistance and connector timing

Quick Claude requests reuse the account-bound connector catalog and send their prompt after checking the account and current connector snapshot. Pending apps can finish connecting while the model starts. Every connected tool call checks the live server's provenance, read-only status, selected account and lookup budget. Other lanes retain the readiness wait. Metadata-only discovery overlaps app and call startup; it sends no model prompt. First use without a cached catalog can still need discovery.

Request timings distinguish provider setup, catalog discovery, runtime startup and connector readiness. `npm run perf` reports these phases when present. SDK input usage sums all tool rounds, so the existing token totals are not a measurement of one prompt's length.

After building the test bundle, `node test/assistance-live.mjs` runs four fictional response cases and one learning case through the selected shared Claude subscription. It reads connector metadata and blocks external tool execution. It does not record audio or edit preferences. `--verify` reruns the two factual-grounding cases and learning case, storing their actual outputs for review. Reports are under `test/.work/assistance-live`. These are small controlled checks; historical Opus call logs and current Sonnet fixture timings are not a paired speed comparison.
