# Listening and learning during calls

Togle separates audio capture, speaker identity, transcription, and reusable agent learning. A speech provider turning audio into words does not establish who spoke. Local speaker models do that work independently of what turns the speech into words.

## Speaker changes

Energy-based capture may include a quick handoff in one audio chunk. The speaker worker now turns neural diarization regions into contiguous, timestamped audio slices, and each slice receives its own transcript and identity evidence. A twenty-word statement followed by a four-word reply no longer has to receive one majority-speaker label. Overlap stays uncertain. Same-speaker regions separated by silence stay together, and every sample belongs to exactly one slice.

Short disconnected regions that clip-level clustering merged receive an acoustic embedding recheck. A clearly different region can become a separate local turn; the call-wide voice matcher still decides whether it belongs to an existing person. A short uncertain reply cannot inherit the previous speaker through weak continuity. Deferred short speech remains available for later confirmation within the call, bounded to 512 observations.

Speaker processing runs in a utility process. Transcription waits at most 1.8 seconds for splitting, proceeds immediately if the model is unavailable, and continues if the worker fails. This is bounded offline analysis of captured speech, not instantaneous speaker recognition. Brief speech, overlap, noise, similar voices, and new microphones can remain uncertain. Confirmed voice memory and corrections remain available; inferred names do not silently become confirmed profiles.

The People count represents distinct voice identities. “Some labels pending” describes transcript passages without a confident label; it never presents those passages as additional people.

## Agent wording and quiet learning

An explicit first-person lesson such as “When I say so three, write SOH 3” saves an alias and spelling to the current agent. The direct chat path needs no model request. Other natural corrections can use the agent’s `save_speech_word` tool. During a call, only an explicit microphone-side lesson is learned immediately; remote speech cannot directly teach a wording rule.

Rules are readable lines in the existing agent vocabulary. Matching uses complete Unicode word boundaries, longest phrases first, and one replacement pass. Legacy comma-separated vocabulary remains valid. Corrected spellings receive priority in the transcription hint budget. Teaching phrases retain their original wording so an old correction cannot rewrite a new lesson before it is learned.

Call recognition uses its owning agent’s rules. Dictation snapshots the selected agent’s rules and its speech account’s dictionary before recording; agent-specific aliases take precedence. Later agent, account, or vocabulary changes cannot reroute that recording. Cleanup-off dictation still applies explicit spelling corrections.

Routine automatic review is hidden from chat. Knowledge shows learned words and names; Learning retains corrections, evidence, pending approvals and Undo. Undo of one wording line preserves later independent corrections. Existing review safeguards for sensitive or conflicting changes remain in place. Learning changes stored context and assistance policies, rather than training model weights.

## Listening controls and voice bar

Mic and Call controls independently stop their capture tracks and invalidate pending recognition for that input. Paused audio is not queued for later transcription. Pausing clears visible captions immediately. Device changes cannot reopen a paused input; rapid pause/resume follows the most recent choice and releases stale streams. Both inputs may be paused while the call remains open. These controls do not mute the microphone or speakers in Zoom, Meet, or another meeting app.

The idle and recording bar is 48×12 CSS pixels, with a translucent background and a waveform driven by microphone levels. Hover expansion waits 500 ms and leaving cancels it. Dragging moves the nonactivating window without toggling dictation or taking keyboard focus. Position is stored as display-relative visible-bar anchors, accounting for Windows DPI rounding. Recording, hover and processing do not resize the native Windows/macOS canvas. Processing keeps a compact progress indicator until insertion or a recoverable error.

## Verification

- `npm test`: wording lessons, agent isolation, persistence and independent Undo; microphone-only teaching; dictation vocabulary snapshots; speaker handoffs, overlap, short-reply matching and later backfill; independent input pause, stale streams, caption clearing and late-result rejection.
- `npm run test:ui`: production renderer with isolated fixtures, including independent input controls and the People uncertainty wording.
- `npm run test:dictation:ui`, also `-- --native`: fake audio, repeated hover, delayed expansion, cancellation, progress, drag, retained focus, renderer recovery and indicator preference. Neither moves the real pointer nor types into another app.
- `npm run test:voices:handoffs`: cached public AMI audio with manual word timestamps. Prepare fixtures first with `npm run test:voices:meetings`. Every eligible fixed 20-word/4-word handoff in ES2002a and ES2003a is tested with a 400 ms boundary tolerance. Separate single-speaker controls exclude annotated overlap, enrollment and handoff windows. Identity controls compare against fixed enrollment examples; unknown is recorded separately from a confident wrong name. Reports include processing latency and raw split counts under `test/.work/voice-handoffs/report.json`.

On the development machine, all five fixed handoffs passed, with boundary estimates 15–342 ms from the next speaker’s annotated onset. Thirteen separate single-speaker controls produced no extra splits or confidently wrong identities; two remained unknown. These are small regression fixtures, including cases used while debugging, not an end-to-end accuracy guarantee. Timing depends on hardware and does not include subscription transcription or suggestion generation. Public AMI recordings are licensed CC-BY-4.0; source and checksums are retained in the existing meeting fixture manifest. No user call audio is used by this benchmark.
