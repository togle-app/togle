# Performance checks

Run `npm run perf:app` to build Togle and drive its production window with made-up calls, real OS encryption and no accounts, microphones or AI requests. It uses its own profile under `test/.work/perf/` and writes its numbers to `test/.work/perf/latest.json`.

What it sets up: 61 encrypted calls, one of them 20,000 lines long, and then a call written down live that grows to 5,000 lines. What it checks: listing the calls cold, opening the same saved call again and again, saving the long call, the window starting, opening the long transcript in Meetings and searching it, showing more of it, and each new line of the live call. It also checks that search finds the last line, that reopening a call decrypts it only once, that the transcript in Meetings starts at 100 rows, and that a change to another call doesn't reload the one that is open.

Measured on the development Windows PC on 2026-11-12:

| Step | Time |
| --- | ---: |
| List 61 saved calls, cold | 1.3 ms |
| Open the same saved call again, median | 2.6 ms |
| Save the 20,000-line call, median | 29 ms |
| Window ready | 359 ms |
| Open the 20,000-line transcript in Meetings | 65 ms |
| Search it for its last line | 32 ms |
| Put 5,000 lines into a live call | 224 ms |
| A new line in that live call, median | 52 ms |

The last row includes about 33 ms of the check waiting for two frames to be drawn. Before 2026-11-12 the live call page drew every line again for each new line and each live caption, and the same step took 274 ms. Now each line is drawn once, and lines out of sight are not laid out until they scroll into view.

These numbers are the app's own work on this PC. They don't measure speech recognition or the AI.

## Real calls

Togle logs timings of real calls, never their words, to `perf.jsonl` in its data folder. `npm run perf -- --days 7` sums up the last week: how long speech recognition took for each finished line, and whether the line was noisy.

## Limits that keep long calls quick

- Meetings shows 100 calls and 100 transcript lines at first, then more on request. Search and export always use the whole saved call.
- The call history keeps up to four decrypted calls in memory, 16 MiB of text at most. The rest stay encrypted on disk. Reads and writes go one at a time, and deleting a call drops it from memory too.
- Saving a call copies only what history keeps: the transcript, the marks and whether the person told the others.
- The live call keeps every line on the page, as the design shows it. A line is drawn when it comes and again only when it changes (a name given, a mark).
