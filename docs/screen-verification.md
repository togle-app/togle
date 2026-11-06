# Screen context verification — 29 October 2026

Verified on this Windows machine with Electron 44.9.2 and the signed-in Claude subscription. These results came from an isolated verification build. For the current app, run `npm run pack`, then `npm run open`; the canonical Windows build is `dist/win-unpacked/Togle.exe`, with its identity in `dist/build-info.json`.

| Check | Result |
| --- | --- |
| TypeScript checks | Passed for main, preload, shared types and renderer |
| Automated suite | 534 passed, no failures or skipped tests |
| Generated temporal scenarios | 500 timelines checked for later-frame substitution, timestamp consistency and upload bounds |
| Production renderer UI | Passed at 400px and 640px, including screen timing details |
| Native Electron integration | Passed actual IPC lifecycle, source ownership, stale-capture rejection and call end |
| Actual Windows capture | Passed production recorder, preload, display-media handler and IPC with decoded fictional window pixels |
| Live Claude with actual capture | Passed historical lookup after the visible chart changed |
| Packaged renderer | Passed the complete UI suite from `app.asar` |
| Package integrity | All six main/preload/renderer build files match the tested output; official Claude CLI is unpacked |
| Windows icon | Embedded primary icon and runtime assets verified |
| Long-call performance | A 20,000-line transcript opens in 30ms and searches in 33ms in the measured scenario |

The real capture scenario displays a fictional blue chart containing Alpha = 20 and Beta = 35. It records a spoken screen reference, changes the visible window to a red chart containing Alpha = 99 and Beta = 1, then asks Claude about the earlier reference. Claude answered **“Beta is larger, at 35. Alpha is 20.”** It requested epoch timestamp `1793309736641`; the uploaded sample was captured at `1793309736609`, 32ms before that reference, from the verified blue window. The run accepted 32 timestamped JPEG samples and also checked pause/resume, call end, closing the selected source and denial of capture without a prepared source. Unexpected main-process promise rejections fail this test.

The audit fixed concurrent reads leaving the activity indicator stuck, cancellation affecting another consumer of a shared read, expired samples advertised as available, a new question inheriting an unrelated older screen reference, false Croatian visual-reference matches, delayed encodes shifting the call clock, live refreshes lost during encoding, implicit fallback to another display, and incorrect rejection of a missing source in Electron. Regression tests cover these cases; the native capture test covers the display-media handler directly.

For repeatable commands and architecture, see [Automatic screen context](screen-context.md). Detailed local evidence is in `test/.work/screen-verified-*.log` and `test/.work/screen-capture/live-result.json`. Tests use isolated profiles and fictional content; no microphone or real call was used.

This verifies the exercised flows on this machine. Screen history is sampled approximately every 500ms and retained for up to two minutes, subject to memory limits. It is a sequence of timestamped images rather than continuous video. Missing history is reported explicitly, and the system does not substitute a later screenshot. AI interpretation and other machines or conferencing environments still require real-world validation.
