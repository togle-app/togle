# Togle

You talk and decide, and your agents do the work. Togle types what you say, writes down your meetings, shows every agent on your computer and keeps the list of what needs you.

Togle is free and open source, under the [MIT license](LICENSE). It runs on your computer, on Windows and macOS, with Linux packages that build but are not tested yet ([macOS setup and testing](docs/macos.md), [Ubuntu setup and testing](docs/linux.md)). It has no account of its own and adds no bill: it uses the AI plan you already have.

**Togle Studio**, a separate paid app (not open source), removes background noise from your voice in every call app. Togle works the same without it. See [Togle Studio](#togle-studio).

## Install on Windows

If you already downloaded the installer, open Command Prompt in its folder and run the following for version 0.1.0. Use the filename of your download.

```cmd
start "" /wait "Togle Setup 0.1.0.exe" /S
```

For a public Windows beta, open its GitHub release and use the Command Prompt line in the release notes. It downloads the signed installer directly from GitHub. [Togle Free releases](https://github.com/togle-app/togle/releases)

Starting with 0.1.0-beta.2, open Togle from the Start menu, then open a new Command Prompt and run `togle tasks` to list your tasks.

Once the stable Windows release and website install script are published, you can also install from any folder with the following command.

```cmd
powershell -NoProfile -Command "iex (irm https://togle.app/install.ps1 -ErrorAction Stop)"
```

It checks the installer's signature and installs Togle for your Windows account. Open **Togle** from the Start menu. [Windows downloads](https://togle.app/#download)

## Four things, one app

The window has three places, **To-do**, **Agents** and **Meetings**, and **Settings**. It opens on To-do.

**The first minute.** On a Togle that has never run, To-do opens on three steps instead: get speech recognition (one download, the size on the button; then F9 works offline), sign in with your ChatGPT plan or skip it, and what Togle found on this computer. What you skip goes on your to-do list.

### Voice

Hold **F9** and talk. Togle types the words where your cursor is: a chat, an editor, a terminal. On a Mac the system asks once before Togle may type into other apps, and until then Togle copies the words. On the newer Linux desktops (Wayland) an app can't hold a key or type into another, so there F9 starts and stops and Togle copies the words for you to paste. **Esc** cancels.

- Your AI plan cleans the words up: punctuation, filler words, and a correction you make halfway ("send it to Dario, no wait, to Marta"). Without a plan, or with cleanup off, Togle types the words as heard. Cleanup has eight seconds; if it fails, you get the words as heard, and the voice bar says why (no internet, the plan at its limit, too slow).
- Speech is heard on this computer. Your plan gets words, never sound.
- In a terminal Togle enters the words on one line. You press Enter to send. If the original text field is missing or changes, Togle copies your dictation and keeps the words in the voice bar. Windows administrator windows also use the clipboard. When you paste the words, the bar returns to normal and the clipboard stays available. The tray keeps your last ten dictations in memory under **Copy a recent dictation**.
- **Names and terms** (Settings): tell Togle once how a name or a word is spelled, or a phrase that stands for a longer text ("my work email"), and it writes it that way from then on.
- The voice bar is a small strip that shows when the microphone listens. While idle, the microphone is off. You can hide the idle bar from the tray menu.

**F8 Show.** Press and release F8. Drag to crop, then drag again to draw a red arrow. You can speak while drawing or switch to Circle, Rectangle or Draw. Press F8 again. With a text box focused, the screenshot and your words go there. Togle Chat shows an image attachment. Text-only fields receive the saved PNG path. With no editable field, F8 copies the screenshot and your words to the clipboard. Open the voice bar to preview the result or copy it again. Pasting returns the bar to its resting state. Esc cancels while drawing.

[How dictation reaches the box](docs/dictation-insertion.md).

### Meetings

Togle writes down both sides of a call on this computer: your microphone is **You**, and what the computer plays is **Call**. The sound never leaves the computer.

- **Starting.** **Write down now** in Meetings starts at once. Togle also notices when Zoom, Teams, Webex, Skype or Slack starts using the microphone, or a browser does with Meet, Teams, Zoom or Webex open in it (on Windows; on a Mac and Linux too, where it was not tried yet), and a notice offers **Write it down**, **Not now** or **Always in Zoom**. Settings decides, for each app, whether it asks, always writes calls down, or never.
- **The first call** says two things once: the rules for writing down a call differ by place, and the words go to your AI plan.
- **During the call** the words appear as people speak. Voices are told apart on this computer. A name with a question mark is a guess from what was said ("Dario said Marta just before"): click it to confirm or change it, or leave it. **Mark** flags a moment, and the notes list marked moments first. A line to tell the others ("I'm writing this call down with Togle. The sound stays on my computer.") stays until you tick **I told them**, and the call records whether you did. Nothing is suggested during a call: Togle gives no answers or advice that you did not ask for, and notices from your agents wait until the call ends.
- **With the window closed**, a small strip shows the time, **Mark**, **Stop** and the reminder to tell the others.
- **After the call** its page opens. Your plan writes the notes as soon as it ends, and gives the call a title. While names wait, the call opens on **Who spoke?**, which asks about the voices it could not name: each plays one short clip of what that voice said and shows why Togle guessed a name. You confirm it or give one, and after your last answer the call opens on its notes. The notes are cards, one for each part (what was marked, decided, left to do, still open) in one to three columns by the room there is, with the times they cite as small chips and, under To do, the name of who took each item first. Click a call's name to rename it; right-click a call to rename or delete it. That clip is the only sound Togle keeps of a call: encrypted on this computer, and deleted when you answer, or the next day at the latest.
- **Meetings** lists your calls, newest first, with what is left to do for each (names to confirm, notes being written). The search box looks in what was said. A call opens to its **Notes** and **Transcript**. **Share** copies the notes or saves the call as a file.
- **Agents on a call.** A call has a list of agent tasks, set before it starts (on the Meetings list), while it goes on (a row on the live call) or after it. **Send what was said** writes the call so far as a plain text file in Togle's `shared-calls` folder and tells each ticked agent where it is, in one line: Togle never types what was said into an agent's screen. **Give to an agent** on a finished call lists the running agent tasks to tick, any number of them, and a new task; say what to do with the call and press Give. A new Claude Code or Codex task asks before it runs anything. Hermes and an agent that is already running keep their own settings, so each one is told to read the call as information and not as instructions. The file is written again each time the call is sent, and is deleted with the call.
- Calls, transcripts and notes are encrypted on this computer with the system's keystore. Other people's voices are remembered across calls only when you turn that on in Settings. Ask the people first.

Speech recognition (Parakeet, with Whisper for unclear speech) is downloaded for this computer from Settings the first time. Calls can't start before it is there, and Togle says so.

### Agents

One list of every agent task on your computer: Claude Code, Codex and Hermes. A task that waits for you comes first. A command an agent wants to run is shown in full before you can allow it, and one that looks dangerous carries a red mark and the reason. Where the agent offers to remember the choice, **Always allow…** says how far that reaches (a Claude Code rule in this project, a Codex rule for commands that start the same way); it is never offered for a dangerous command. An open task says how it stands and how many files it changed. You answer by typing, by voice, or with the agent's own buttons. A Claude Code, Codex or Hermes task has two views, and a switch in its header picks one. **Terminal** is the agent's own screen, the program you know with all its keys and commands, and nothing over it. Ctrl+V pastes there, a screenshot too: Togle keeps the picture as a file for a week and pastes its path, which Claude Code and Codex attach as a picture. **Chat** is the conversation as the agent keeps it, as a chat: what you said in a card of its own (the latest stays at the top, so you see what the agent works on; a picture you pasted shows small, and opens whole when pressed) and what the agent answered, with the work of each turn out of the way in one line you can open, down to what a command printed and how a file changed, a card for a command, a question or a plan that waits, and a reply box that takes words while the agent works: they wait, and go in when its turn ends (Hermes asks on its screen, and Togle says it waits there). Settings says which view a task opens in. A notice comes in both views, even over Togle's own window. The work runs outside the screen, in the agent's own background session, thread or gateway: it goes on when you close the screen or quit Togle. **Hand back** gives you the line to open it in your own terminal. A Claude Code you started in a terminal shows here too, and **Take over** moves it into the background and opens its screen here. `togle run claude` starts one from the command line. In the reply box of a task of an agent you added through ACP, type `/` to see the agent's own commands.

**F10** opens a small task box over whatever you are doing: say or type the task and press Enter, and the agent starts in the folder you used last.

When an agent starts waiting or finishes, one notice appears in the corner. It never takes your keyboard, and **Allow once** is held for a moment so a stray click can't allow anything. The tray icon carries an amber dot until nothing waits.

Any other agent can be added in **Settings → Agents → Add another agent**. Pick one from the list: the agents found on this computer first, then more from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), which start through `npx` or `uvx` (they fetch the agent the first time). An agent that is not listed is added by a name and the command that starts it, and **Edit** on an added agent changes its command later. A command for ACP, the open standard Hermes uses (it has `acp` in it, such as `gemini --acp`), is talked to directly, and Togle shows its conversation. Any other command runs in a terminal of Togle's own that you read and type into in the task. **Remove** takes an agent off Togle's lists: one you added is forgotten, and one Togle found stays installed with its tasks going on in it, and can be added back. Togle starts each agent's own program and uses the agent's own sign-in. It never reads an agent's login or keys. See [Coding agents on this computer](docs/agents-on-this-computer.md).

### To-do

One list for the day, kept as a plain text file on your computer. What your agents need from you sits at the top, in amber. Every task you give an agent is on the list, says what the agent is doing (working, waiting for you, idle), and stays until you tick it. You add an item by typing or by holding F9. Remove a single item or use **Clear list**. Your meeting follow-ups appear in the meeting notes and under **From your calls**. Choose **Add** or **Dismiss** for each one.

## Keys

| Key | Does |
| --- | --- |
| F9 | Talk: hold, talk, let go (on a Mac or Linux: press to start, again to stop) |
| F8 | Release to crop. Draw a red arrow and speak, then press F8 again to insert both. |
| F10 | Task: the box to give an agent a task |

They work from any app. Settings can give each other keys: click it and press the keys you want. Keys that would stop working in every other app are refused with the reason. On most Mac keyboards, F keys need Fn held.

F9, F8 and F10 are also debugger keys in VS Code, Visual Studio and JetBrains IDEs. The first time you press one while one of those editors is in front, a notice in the corner offers **Change keys** once; the key still does its job in Togle. The notice never comes back. On a Mac Togle tells the editor by its app (`lsappinfo`), on Linux by its window (`xprop`, X11 and XWayland); neither was tried on those systems yet.

## Your AI plan

Togle has no account and no bill of its own. **Sign in with ChatGPT** (Settings → Accounts → AI plan) uses your ChatGPT plan: what Togle uses counts toward its limit. Without a ChatGPT plan, **Use a key** from Claude (an Anthropic API key; Togle has no Claude sign-in), Gemini, Grok, Kimi or any OpenAI-compatible service (OpenRouter, Groq, or a model on your computer with Ollama or LM Studio). Togle checks the key by listing the service's models, then uses one model for every job: the key cleans up dictation and writes the notes, as the plan would. The service bills you for it.

| | With your plan | Without it |
| --- | --- | --- |
| Voice | Fixes punctuation, drops filler words and follows a correction you make halfway | Types the words as heard |
| Meetings | Writes the notes as soon as a call ends, and gives the call a title | Keeps the transcript. You can give the call to an agent, which writes them |
| To-do | Offers the action items from each call | You add items yourself |
| Agents | Puts tasks about the same thing under one heading, from their names and the start of what you asked in each (Settings → Agents turns it off) | No headings |

Your plan gets words, never sound. Your agents keep their own sign-ins, which Togle never touches.

## When something goes wrong

- **Togle can't type into the box.** Your words are kept for Copy, and the tray lists your last ten dictations.
- **An agent is signed out, or stops by itself.** Its row waits for you and says why. Signed out, it gives the command that signs the agent in again, with **Copy**.
- **No agent is installed.** The Agents screen names the ones Togle knows, each with the line that installs it.
- **No internet, or your plan is at its limit.** Dictation types the words as heard and says which. Transcripts and the to-do list still work.
- **The microphone or the call's sound can't be opened.** The call goes on with the other one and says so, and **Reconnect audio** tries again.

## Setup

Requires Windows 10/11, macOS 14.2+ or Ubuntu 22.04+ (with PulseAudio, or PipeWire's pulse server), and Node 22.12+. Linux execution remains unverified. Mac build commands, permissions, feature differences and the manual acceptance checklist are in [docs/macos.md](docs/macos.md).

```sh
npm ci
npm run dev             # then Settings → Voice → Install
```

On Windows, `npm run setup:whisper` sets up a development copy in `resources/whisper` instead (~1.9 GB with an NVIDIA GPU), which Togle runs while nothing is installed from Settings. It uses the CUDA build and `large-v3-turbo` when it finds an NVIDIA GPU, otherwise the CPU build and Whisper `small`. You can override both: `npm run setup:whisper -- --cpu --model ggml-medium-q5_0.bin`. It also downloads Parakeet TDT v3 (~670 MB, skip with `--no-parakeet`; Whisper then does everything). Interrupted downloads resume where they stopped.

**A key instead of a plan** (Settings → Accounts → AI plan → Use a key): Claude (Anthropic's own API), Gemini, Grok and Kimi are ready to pick; **Another service** takes the address of any OpenAI-compatible one (OpenRouter, Groq, Ollama, LM Studio). A reasoning model's thinking that comes inside the answer text (`<think>…</think>`) is left out.

**A build to install.** Build on the system it's for. `npm run dist` makes what installs Togle: on Windows `dist\Togle Setup 0.1.0.exe`, on macOS a `.dmg` and a `.zip` for the build Mac's architecture, on Linux an AppImage and a `.deb`. `npm run pack` makes only the app, to try it (`dist\win-unpacked` on Windows), and checks the packaged code against a build manifest; `npm run open` opens that copy. Speech recognition isn't in any of them: Togle downloads it for the computer it's on. The app keeps its data where `npm run dev` does (`%APPDATA%\togle` on Windows). Nothing is signed yet: Windows SmartScreen warns before the first run, and macOS distribution needs Apple Developer ID signing and notarization; see [the Mac build guide](docs/macos.md).

## Project layout

```
src/main/              Electron main process
  auth/chatgpt.ts      Sign in with ChatGPT: browser PKCE, ID token checks, refresh, revocation
  providers/           the AI: chatgpt.ts (Responses API with ChatGPT plan usage), compat.ts (Chat Completions)
                       and claude.ts (Anthropic's own API, with a key). Togle has no Claude sign-in
  plan.ts              the ChatGPT plan's usage limit
  dictation*.ts        voice typing: the shortcut, the voice bar window, cleanup, inserting the words, history
  stt/                 speech recognition on this computer: Parakeet (main), Whisper (unclear speech), downloads
  hearing.ts           a call's audio to live captions and transcript lines
  ongoing-call.ts      the call as it goes: what was said, in order, voices and names, marks, "I told them"
  call-file.ts         the call so far saved as it goes, so a crash or a restart doesn't lose it
  call-sessions.ts     calls saved encrypted; meeting-notes.ts and call-titles.ts write their notes and titles
  confirm-sound.ts     the one short clip of each voice that Who spoke? plays, deleted within a day
  call-detect.ts       which call app uses the microphone (Windows, Linux; a Mac in mac-audio-processes.ts); call-notice-window.ts, call-strip-window.ts
  runners/             Claude Code, Codex, Hermes and added agents (acp.ts speaks ACP for any agent added):
                       their tasks, requests and stops; hub.ts holds them together; claude-sessions.ts lists
                       Claude Code's own sessions; codex-daemon.ts and codex-link.ts join Codex's shared server
  agent-store.ts       what a call belongs to, with the words calls are heard with
  channel/, cli/       the togle command, and the local channel it reaches Togle on
  todo.ts              the to-do list as a plain text file
  task-box-window.ts   the F10 box; notice-window.ts the corner notice; tray.ts the tray
  microphone-link.ts   Togle Studio, when it's on this computer: found, watched, turned on and off around calls
  reach/               Togle on your other devices (part of Togle Studio, not in releases until reviewed): keys,
                       the list of your devices, adding one by its code, what passes between them
src/shared/            what the main process and the window share (types, the IPC api, hotkeys, call apps)
src/preload/           the window.togle bridge
src/renderer/src/      React: Shell.tsx (the window), Todo.tsx, Tasks.tsx (Agents), MeetingsPage.tsx,
                       LiveCall.tsx and useCall.ts (a call), ConfirmNames.tsx, SettingsPage.tsx, TaskBox.tsx,
                       DictationBar.tsx; audio/capture.ts opens the microphone and the call's sound
test/                  automated tests
eval/                  the speech evaluation, with real speech on this computer
electron-builder.yml   what a build holds, for Windows, macOS and Linux
```

## Tests

```sh
npm test               # main process and shared code, with fakes: no account, device or plan usage
npm run test:ui        # the window: To-do, a call written down, Meetings, Who spoke?, narrow sizes; fake api, silent audio
npm run test:tasks:ui  # Agents and To-do: requests, Allow, Stop, the task box, notices, the quit question
npm run test:native    # the real main process and window with an isolated profile and the OS keystore
npm run test:tray      # the tray, closing to it, quitting during a call
npm run test:notice    # the corner notice and the tray's amber dot
npm run test:dictation:ui      # the voice bar with a fake microphone
npm run test:dictation:native  # F9 into Togle's own Windows test window (desktop unlocked)
npm run test:voices:clips      # the clips Who spoke? keeps, on public voice samples
npm run speech         # speech recognition with background noise, on this computer only
```

## Sign in with ChatGPT

Togle uses OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source), with ChatGPT plan usage: what Togle uses counts toward your ChatGPT plan, not an API bill. **Sign in with ChatGPT** opens your browser. The first time, ChatGPT asks you to allow Togle to use your plan, and registers Togle for your account and this computer (a random host ID, nothing that identifies you). Later sign-ins reuse that registration.

- The sign-in uses PKCE and comes back to a loopback address on this computer. Togle checks the ID token against OpenAI's published keys, and checks that you allowed plan use, before any request.
- Requests go to the public Responses API (`api.openai.com/v1/responses`): never stored at OpenAI (`store: false`), streamed, and only with the fields that route accepts. Words, never sound.
- What Togle uses of your plan, and any limit you set for it, is in ChatGPT's settings: **Manage usage** opens [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- **Sign out** forgets the tokens here and ends the session at OpenAI. You can also disconnect Togle in ChatGPT's settings.

Tokens and API keys are encrypted with the system's keystore (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret on Linux) in Togle's data folder.

## Togle Studio

[Togle Studio](https://studio.togle.app/) is a separate app, not open source, that removes background noise from your voice in every call app, on your computer. Togle works the same without it, and never mentions it during a call.

- **Found by itself.** Togle asks your computer whether Togle Studio is installed: the program its installer puts there. An app that was removed, or a copy run from source and then closed, does not count, and one that never ran does. When Togle Studio runs, it leaves a link file in its own data folder and serves a local socket that only your user can reach. Togle reads the file, proves it with the token in it, and from then on knows whether the clean microphone is on and what it cleans. Only that state travels over the link, never audio. The protocol is in [`src/shared/microphone-link.ts`](src/shared/microphone-link.ts).
- **On for calls.** With **Turn on during calls** (Settings), a call that starts turns it on first, so the call hears the clean microphone, and turns it off again when the call ends, unless it was already on.
- **Signed in to it.** Togle Studio is used with its own account. While you're signed out of it, a call leaves it alone, and Settings offers **Sign in**, which opens its window. Togle only learns whether someone is signed in, never who.
- **What your microphone picks up.** Without it, Togle measures your microphone during calls while nobody speaks: how often the background is loud enough to hear, and short sounds such as typing. Only levels are kept, in memory. After a noisy call (at most every few days, never during one), the call's page says for how many minutes the microphone picked up room noise, with one link: **Clean my microphone**. **Mention Togle Studio** in Settings turns that off.

**Reach**, the part of Togle Studio that connects Togle across your computers, a server and your phone, is being built. Togle's side is in this repository and makes every decision; Studio only carries what your devices lock for each other. It stays out of every release until an outside review has tried to break it. See [Reach](docs/reach.md).

The link to Togle Studio's site uses `STUDIO_SITE` in [`src/shared/microphone-link.ts`](src/shared/microphone-link.ts): studio.togle.app. Togle's own site is togle.app (`TOGLE_SITE`); the domain has to be registered before a release.

## Be upfront with the people you talk to

Togle writes down what the other side of the call says. The rules for that differ by place, and in some places everyone on the call has to agree. Togle gives you a line to tell them; use it.

## License

[MIT](LICENSE). Togle Studio is not part of this repository and has its own license. Third-party components keep their own licenses, listed in [resources/licenses](resources/licenses) and in each package under `node_modules`.
