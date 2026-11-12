# How Togle is built

Togle has four parts, each a screen in its window: **To-do**, **Agents**, **Meetings** and **Settings**, plus three keys that work in any app: F9 Talk, F8 Show and F10 Task. Everything runs on the person's computer. This page says which code does what, what is kept where, and what goes to an AI.

## Processes

- **The main process** (`src/main/index.ts` and the modules beside it) owns everything that touches the system: keys, files, accounts, speech recognition, the agents' programs.
- **The window** (`src/renderer/src`, React) draws the four screens. It reaches the main process only through the bridge in `src/preload/index.ts` (`window.togle`, typed in `src/shared/api.ts`). The window and the main process share types and plain functions through `src/shared`.
- **Small windows** of their own: the voice bar (`dictation-window.ts`), the corner notice (`notice-window.ts`), the call notice (`call-notice-window.ts`), the strip shown while a call is written down and the window is closed (`call-strip-window.ts`), the F10 task box (`task-box-window.ts`) and the F8 overlay (`show-window.ts`). None of them takes the keyboard except the task box and the overlay, and all of them are hidden from screen capture.
- **Helper processes**: Parakeet and Whisper hear speech (`stt/parakeet-worker.ts`, `stt/whisper-worker.ts`), and a third tells voices apart (`stt/voice-worker.ts`). Each runs in an Electron utility process, so a crash in native code doesn't take Togle down.
- **Programs Togle starts or answers**: the coding agents (below), the hook Claude Code runs to ask Togle about a command (`Togle --togle-hook claude-permission`), and the `togle` command (`cli/`).

## Voice

F9 starts and stops dictation (`dictation.ts`). The voice bar's page records the microphone; `dictation-speech.ts` hears it with this computer's speech recognition and, when the person has an AI plan signed in or a key added, has it clean up the words (the quick model, low effort). With neither, the words go in as heard. `dictation-target.ts` types the result into the box the person was in, through a helper that checks the same window and box are still there first (Windows); elsewhere it offers Copy. A terminal gets the words as one line; a window that runs as administrator, which takes no typing from Togle, gets them on the clipboard. The word list and recent dictations are kept per account (`dictation-vocabulary.ts`, `dictation-history.ts`).

F8 Show (`show-window.ts`) freezes the screen under the pointer in a content-protected overlay. The person drags out a part and can draw on it; Enter saves the picture to Togle's `pictures` folder, puts the box they were in back in front and pastes the picture there, then the words they said meanwhile. In a terminal it types the picture's path instead.

## Meetings

A call starts when the person writes it down (a button, the call notice, or Always for that app). `call-detect.ts` notices a call app using the microphone: on Windows from the registry, with Meet, Teams, Zoom or Webex in a browser told by its window title; on Linux from what PulseAudio or PipeWire lists as recording, with a browser's window titles read through `wmctrl` where it can (X11, and programs under XWayland). On a Mac (macOS 14.2 and later) Core Audio lists the processes recording from a microphone with their bundle ids (`mac-audio-processes.ts`), and a browser's window titles are read only once screen recording is allowed; this was not tried on a Mac yet.

The window's `audio/capture.ts` cuts the microphone and the computer's sound (the other side of the call) into pieces of speech. `hearing.ts` turns them into live captions and transcript lines, with Parakeet first and Whisper for unclear speech, or a speech service the person picked for a side. `ongoing-call.ts` keeps the call: the lines in the order they were said, the microphone's copy of the other side taken out, the voices and their names, the moments marked, and whether the person told the others. `stt/voices.ts` tells the voices apart; a voice is remembered across calls only when the person turns that on (`stt/voice-memory.ts`).

The call is saved as it goes (`call-file.ts`), encrypted, so a crash or a restart doesn't lose it. Once saved, it is in Meetings (`call-sessions.ts`, encrypted, one file per call). After the call:

- **Who spoke?** (`shared/confirm-names.ts`) asks about the voices it isn't sure of, with a short clip of each. The clips are the only sound Togle keeps of a call (`confirm-sound.ts`, encrypted), and they are deleted once the names are answered or skipped, or the next day at the latest.
- **Notes**: `meeting-notes.ts` sends the transcript, the marks and the person's own notes to their AI and keeps the notes it writes; `call-titles.ts` names the call the same way. Nothing goes to an AI during the call.
- **Give to an agent** writes the call as a plain text file in `shared-calls`, for a coding agent to read; it goes with the call, or after 14 days.

## Agents

`runners/` drives the coding agents on this computer, each through the way its maker offers: Codex through `codex app-server` (`codex.ts`), Claude Code as a program Togle starts, with a hook on 127.0.0.1 and a secret per task for its permission requests (`claude.ts`, `claude-hooks.ts`), and Hermes and any agent the person adds through ACP (`acp.ts`, `hermes.ts`); any other agent the person adds runs in a terminal of Togle's own through node-pty (`terminal.ts`), shown in the task as an xterm terminal. `hub.ts` puts every task in one list; `register.ts` connects it to the window. A task Togle starts asks before every command and edit; the window shows the whole command before Allow once, with a plain warning on dangerous ones. `changes.ts` reads what differs from the last commit with git, read-only. `attention.ts` decides what the corner notice and the tray's dot say. A turn that ends with an error stops the task until a reply; when the error means the agent is signed out (`isSignedOut` in `shared/runner.ts`), the row gives the agent's own sign-in command. `search-path.ts` adds what the person's terminal would see to Togle's PATH when an agent is not found (the PATH saved in the registry on Windows, the login shell's elsewhere), so one installed while Togle runs, or a Mac app opened from the Dock, still finds it.

Claude Code in a terminal can ask Togle too, through a hook the person connects in Settings: `channel/` is a local named pipe (a socket file elsewhere) where both ends prove they hold a secret kept in Togle's data folder. The same channel serves the `togle` command. `runners/claude-sessions.ts` lists Claude Code's own sessions for the Agents list, from the start and end of each session file; keys and passwords are taken out of their titles.

Togle sends nothing to an AI for the agents: each agent uses its own sign-in, which Togle never reads.

## To-do

`todo.ts` keeps the list as a plain Markdown file (`to-do.md` in Togle's data folder) that the person can edit anywhere; Togle sees changes as they happen. An item given to an agent task carries a comment with the task's key. To-do also shows what waits for the person in Agents, and "From your calls": names to confirm, notes ready, and to-dos in the notes that are theirs.

## Settings and accounts

`settings.ts` keeps the settings in `settings.json` and checks every value as it loads. Sign in with ChatGPT (`auth/chatgpt.ts`) is the one sign-in offered; a key from Gemini, Grok, Kimi or another OpenAI-compatible service can be used instead (`auth/api-connections.ts`, each key encrypted). A Claude sign-in exists in the code (`auth/claude-code.ts`, `providers/claude-subscription.ts`) but is not offered until Anthropic allows it. `agent-store.ts` keeps what a call belongs to: one agent, with the words calls are heard with.

## What is kept where

In Togle's data folder (`%APPDATA%\togle` on Windows):

| What | Where | How |
| --- | --- | --- |
| Calls | `call-history/` | encrypted, one file each |
| The call going on | `call.bin` | encrypted, picked up again for 3 days |
| Clips for Who spoke? | `confirm-sound/` | encrypted, a day at most |
| Calls given to an agent | `shared-calls/` | plain text, 14 days at most |
| Remembered voices | `voices/people.bin` | encrypted, only when turned on |
| F8 pictures | `pictures/` | PNG files |
| The to-do list | `to-do.md` | plain text |
| Sign-ins and keys | `chatgpt-auth.bin`, `accounts/`, `connections/` | encrypted |
| Settings | `settings.json` | plain text, no secrets |
| Agents' task names and records | `runner-titles.json`, `runner-tasks.json` | plain text |
| The channel's secret | `channel/` | a file in the person's own folder (on Mac and Linux, readable by their account alone) |

Speech recognition, the models Togle downloads, is kept apart from the data (`%LOCALAPPDATA%\togle\speech` on Windows).

"Encrypted" means with the system's keystore, through Electron's `safeStorage`. Without one, Togle doesn't write those files in plain text: it doesn't keep them.

## What goes to an AI

- After a call: its words, marks and the person's own notes, to the AI the person set up, for the notes and the title.
- With dictation cleanup on: the dictated words, to the same AI.
- Speech: heard on this computer, unless the person picks a speech service for a side of the call.
- Nothing during a call, and nothing from Agents or To-do.

## Tests

The README lists the test commands. `npm test` covers the main process and shared code with fakes; the window suites run the real window against a fake bridge; `npm run test:native` runs the real main process and window with an isolated profile and the system keystore.
