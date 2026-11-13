# Coding agents on this computer

Togle lists the tasks of the coding agents on your computer (Claude Code, Codex and Hermes) in one place, and lets you answer what they ask. Each task opens as the agent's own screen: the program you know, in a terminal of Togle's own, with its keys and commands as in your terminal. The work does not live in the screen: a Claude Code task is one of its own background sessions, a Codex task is a thread on Codex's shared server, and a Hermes task is a session in Hermes's gateway. So a task goes on when you close its screen or quit Togle. Togle never reads their sign-ins.

## Agents

**Agents** in the sidebar opens the list. A task that waits for you comes first, with the command it wants to run shown in full.

- **Allow once** lets that one command run. **Refuse** tells the agent no.
- **Always allow…** shows when the agent offers to remember the choice, and says how far it reaches: for Claude Code, the rule it suggests and where it keeps it (this task, this project, or everywhere); for Codex, the words the commands start with, wherever they run; for an agent added through ACP, its own option. Togle passes on only that, never a change of the agent's permission mode. It is not offered for a command that looks dangerous, nor in a notice.
- An open task starts with what the agent said last and how many files it changed; its steps and the conversation fold under one line ("5 steps: edited 2 files, ran 3 commands").
- A command that looks dangerous (it deletes for good, pushes over what is on a server, runs hidden text, changes the computer) carries a red mark and the reason. The mark is a hint. The command shown is what runs.
- **New task** opens the task box (below). A Claude Code, Codex or Hermes task follows your own settings, as in your terminal. A task of an agent you added through ACP asks before every command and every change.
- **Stop**, in the header of a task that works or waits, ends what the agent is doing. On a task that is the agent's own screen it does what Esc does there (Ctrl+C in Hermes), and you can also stop it on its screen. Your other devices can Stop it too. A Claude Code task ends its session and the command it was running (its conversation is kept, and opening its screen again brings it back). Codex lets a command that was already running finish, so a stopped Codex task shows a second button, **End the running command**.
- What finished in the last day stays in the list; older tasks fold under **Earlier**.
- A task that runs in a terminal or in an app shows in the list too. For Claude Code, **Take over** ends the program in the terminal and moves the same conversation into the background, with its screen here. Togle asks first. See "Claude Code's own screen" below.
- A task that stops by itself (a turn that ends with an error, or an agent program that stops) waits for you like a question, and its row says why. When the error means the agent is signed out, the row says so with the command that signs it in again (`claude auth login`, `codex login`) and **Copy**: run it in a terminal, then go on. The words that count as signed out are in `isSignedOut` in `src/shared/runner.ts`; Claude Code's and Codex's were seen on this computer. A Hermes task is its own screen, which shows Hermes's errors itself (a model that does not answer, a sign-in that is missing: `hermes model` sets it): Togle does not read them, so its row says Done.
- With no agent installed, Agents names Claude Code, Codex and Hermes, each with the one line its maker gives to install it and a link to its page. Togle looks for agents the way a terminal would: when one is not found, it adds the PATH saved in the registry (Windows) or the one the login shell sets up (Mac and Linux), so an agent installed while Togle runs shows within a minute. The login shell runs your start-up files, so Togle asks it at most every ten minutes, with no input, and stops it after five seconds; the usual folders (`~/.local/bin`, Homebrew's, `/usr/local/bin`) are checked every time.
- **See changes**, beside a task's name, lists what differs from the last commit in its folder and shows each file's diff. It is read with git. It shows everything in the folder that differs, which can include changes that did not come from the agent.
- Quitting Togle while a task it runs has not finished asks first. A Claude Code, Codex or Hermes task goes on: the question names the ones that are working or waiting for you, and says so. Togle finds a Claude Code or Codex task again when it starts; a Hermes task is a session in Hermes's list, which opens again from there. A task of an agent added through ACP is stopped, with the commands it started, when you quit.

Hermes asks about a command only when its own settings say to. With its approvals turned off, it never asks, and there is nothing to answer. When it does, it asks on its screen.

## The agent's own commands

Type `/` in the reply box of a task of an agent added through ACP, and the agent's own commands open over the box, each with what it does in the agent's own words. Togle keeps no list of its own: it shows what the agent tells it. (A Claude Code, Codex or Hermes task has no reply box: its screen is the agent's own, and its `/` menu opens there, with all of its commands.)

- Go on typing to narrow the list: the commands whose name starts with the letters come first, and when none does, the ones that hold them anywhere (a plugin's `supabase:…`).
- The arrow keys move, **Enter** or a click sends the command as it is (the agent says what it needs), **Tab** completes its name so you can type what follows it, and **Esc** closes the list.
- `/model` lists the agent's models, and picking one switches the task to it. An added agent that speaks ACP is switched the way ACP has for it, and then asked which model it is on, so the answer is its own. Other words after `/model` go to the agent as they are. A switch the agent refuses ends with which model it was and the reason the agent gave.
- The answer shows as what the agent said. A command that the agent does not know goes to its model as ordinary words.

What each agent tells:

- An agent added that speaks ACP tells the commands it has for a session, and the models it can switch to.
- A task in a terminal of Togle's own, and a Claude Code, Codex or Hermes task, is the agent's real program: its commands work there as they always do.

On a Claude Code screen two commands do more than answer. `/clear` empties the conversation: Claude Code goes on in a new session under the same background session, and the task stays the same one in Togle. Once the task is stopped and Togle has been closed and opened again, the conversation before the clearing and the one after it show as two tasks. `/compact` takes a minute or more, with the task working meanwhile.

## Notices

When a task waits and Togle is not in front, a small notice appears in the corner of the screen with the task, the command in full, **Allow once**, **Refuse** and **Open**. It does not take the keyboard, and it is kept out of screen shares and recordings.

- **Allow once** is held for about a second after a notice appears, so a click meant for the window under it cannot allow a command.
- It is not offered for a command that looks dangerous, or one too long to show in full. Those are allowed in the Togle window, where all of the command is shown. A question from an agent has only **Open**.
- A task that finishes or stops with an error shows a notice for a few seconds.
- The tray icon carries an amber dot, and its menu says how many tasks wait, until none does.

## Task box

**F10** opens a small box over whatever you are doing. Pick the agent and the folder, type the task (or hold the dictation key and say it), and press Enter. The task starts, goes on the to-do list, and the box puts itself away. **Esc** closes it, and so does a click elsewhere; what you typed stays for next time, and so do the agent and folder you picked. The key is a setting like the others (**Settings → Keys**), and F10 can be changed there if another program needs it.

Every way of giving work to an agent opens this same box: **New task** in Agents, **Give to an agent** on a to-do item or a saved call, and `togle run claude` in a terminal. Opened from a to-do item, it has the item's words and a chip naming the item; the task that starts is given to that item. **×** on the chip makes it a task of its own.

## Settings

**Settings → Agents** lists Claude Code, Codex and Hermes, found or not. The task box key is under **Keys** (Task, F10).

**Add an agent** takes any other agent that speaks ACP, the open standard Hermes uses: give it a name and the command that starts it for ACP, as its own docs give it. Togle runs that command on this computer the way a terminal would (an agent installed with npm on Windows starts through cmd.exe). The agent then shows like the others: in the list, in the task box, and as `togle run acp-<name>`. It asks before a command as its own settings say, and "always allow" is its own option, in its words. **Remove** takes it off again; what it ran is not undone.

## An agent without ACP, in a terminal of its own

**Add an agent → In a terminal** takes any other agent, by its name and the command that starts it in a terminal. Its tasks run in a terminal of Togle's own (a pseudo-terminal, through [node-pty](https://github.com/microsoft/node-pty)), in the task's folder, and the task's panel is that terminal: you read the agent there and type into it as in any terminal, and F9 types into it as one line. Togle opens on the task when it starts. Its id is `term-<name>` (`togle run term-aider …`).

- Put `{task}` in the command where the task's words go: `cursor-agent {task}`, `aider --message {task}`. They go in as one argument, as written, quotes and all; colors and control characters (a Ctrl+C, say) are taken out.
- Without `{task}`, the words wait above the terminal, and **Type them in** types them, as one line and without Enter: you press Enter once the agent is ready for them.
- On Windows an agent installed with npm or pnpm is a `.cmd` file: Togle reads what it starts (Node and the agent's script) and starts that, without cmd.exe, so `{task}` works as above. Any other `.cmd` or `.bat` starts through cmd.exe, which would read the words as commands: there they wait to be typed in, and the flag that held them (`--message` in `--message {task}`) is left out too. A file that is not a program is refused before anything starts.
- Togle cannot read what such an agent asks. It shows no command before it runs, marks none dangerous, and sends no notice: the agent asks in its terminal, and you answer there.
- The task is working while the program runs, done when it ends by itself, and stopped by an error, with the exit code (or the signal, on a Mac and Linux), otherwise. **Stop** sends Ctrl+C; **End it** ends the agent and what it started. An ended task does not wait for a reply: it ended with its program. The tasks end with Togle, are not picked up again, and leave nothing behind.

## To-do

**To-do**, the screen Togle opens on, is your list. What waits for you is at the top, with the same buttons as in Agents. Below it is your own list.

The list is a plain text file you can also open in any editor: `to-do.md` in Togle's data folder (`%APPDATA%\togle` on Windows). Each item is a line of a Markdown checklist:

```
- [ ] Review the onboarding copy
- [ ] Fix the login redirect <!-- togle:task=claude:3f2a9c1e -->
- [x] Send the invoice to Marta
```

Lines that are not items are left as they are. An item given to an agent keeps the task in the comment at its end. A change in an editor shows in Togle, and a change in Togle names the item by its line and its words, so it cannot land on another item if the file was edited meanwhile.

**Give to an agent** opens the task box with the item's words filled in. The item then shows what the task is doing, and **See changes** when it has finished. You tick the item yourself once you have looked. A task started any other way (the task box on its own, **New task**, the `togle` command) gets an item of its own, so every task you give an agent is on the list.

## From a terminal

The `togle` command starts a task in the running Togle from any terminal, and lists the tasks:

```
togle run claude                               # opens the task box with Claude Code and this folder
togle run codex --folder ./api "Add a status column to the orders table"
togle run "Fix the failing login test"         # Claude Code, in the current folder
echo "Review the onboarding copy" | togle run  # piped text is the task
togle tasks
```

The first word names the agent: `claude`, `codex`, `hermes`, or the id of one added in Settings (`acp-…`). Without one it is Claude Code; a task that starts with one of those words goes after `--`. With no task, Togle's task box opens with that agent and folder, for you to type or say it. A script that pipes in nothing is told to say what the task is, and no box opens.

The task shows in Agents like any other and goes on the to-do list. It follows the agent's own settings, as in your terminal; only a task of an agent you added through ACP asks before every command and every change. The command talks to Togle over a local channel (a named pipe on Windows, a socket file elsewhere), where both ends prove they hold a secret kept in Togle's data folder, so it needs Togle running, and it says so when it is not. It exits with 0 when it worked, 1 when Togle could not do it, and 2 when the command was not understood.

The command is the program `out/main/cli.js`, started by Electron as plain Node (`ELECTRON_RUN_AS_NODE=1`). From a copy of the source, run `npm run build`, then `node bin/togle.cjs tasks`, or `npm link` to get `togle` on your path. An installed Togle has the command beside the app in `resources/bin` (`togle.cmd` on Windows, `togle` on Mac and Linux); add that folder to your path to use it from anywhere. The installer does not add it yet, and the Mac and Linux versions were not tried. From a development run, name the data folder: `TOGLE_DATA`.

## Claude Code's own screen

A Claude Code task opens in Togle as **Claude Code's own screen**: the program you know, in a terminal of Togle's own, with its keys and its commands exactly as in your terminal (`/model`, `/compact`, `/resume`, shift+tab, pasting an image, all of it). It is one of Claude Code's own background sessions (`claude --bg`), and the screen is `claude attach` in that terminal. What Togle adds is around the screen:

- The task is in the list, **Working** while it answers and **Done** when it has. A notice says when it is done, with what Claude Code said last.
- When Claude Code asks something, a card shows it above the screen: **Allow once** and **Refuse** for a command or a change, the choices for a question. The screen shows its own question at the same time. Either one is enough: answer in Togle, or on the screen, and the card goes within a couple of seconds (Togle asks Claude Code whether it still waits).
- A plan Claude Code proposes (plan mode) is a card with the plan whole, and two buttons: **Approve the plan**, after which it goes on in the mode that asks before each edit (as "Yes, manually approve edits" does on its screen), and **Keep planning**, which sends it back and Claude Code asks what to change. For the other choice (auto mode) or words of your own, use the screen.
- Nothing is forced on it. It starts with your own permission mode and your own rules, so Togle sees only what Claude Code asks. If yours never asks (it starts in `bypassPermissions`, for example), no card shows for a command, only for what Claude Code asks you in words.
- **It goes on without Togle.** Closing its screen does not stop it, and neither does quitting Togle: the next time Togle starts, it finds the task again and hears it ask. Quitting names the tasks that are working or waiting for you, and says they go on. **Stop** ends the session (and the command it was running); opening its screen again brings it back, with the same conversation.
- **One screen at a time.** Open the task in your own terminal (`claude attach <id>`) and the screen in Togle closes, saying so; open it in Togle and the other closes. A closed screen opens again with **Open the screen**.
- **Hand back** closes the screen here and gives you the line to open it in your own terminal: `claude attach <id>`, to run in the folder the task worked in. The task goes on and stays in the list.
- Your other devices list the task and show its card. They can **Refuse** a command and **Stop** the task, and never type into the screen: a key could answer "1. Yes". **Allow** from a device waits for proof that it is you, which is not built yet, so a command is allowed at its own computer.
- A task started in Togle (the task box, **Give to an agent**, `togle run claude`) follows your own settings, as in your terminal. It does not ask before every command. A start from another device will ask, when that exists.

A Claude Code you started yourself in a terminal shows in Agents with its state, and its row offers **Take over**. It asks first. It ends the program in your terminal, and moves the same conversation into the background, with its screen here: the same session, with its history. It starts the way your program was: the `--model`, `--effort` and `--permission-mode` flags it ran with are carried over, and `--dangerously-skip-permissions` too. Its other flags are not. A Claude Code that has had no message yet has no conversation to move: Take over says so and leaves it running. If the conversation cannot go on in the background, Take over says why and gives the `claude --resume` line to go on in your terminal.

A conversation goes on in one program at a time. Two programs on one session each know only their own half, and the saved conversation splits in two. So Take over ends your terminal's program first, and Togle never goes on with a copy: when Claude Code says it started one, Togle ends the copy and says so.

Some limits, as Claude Code 2.1.323 has them on Windows:

- A folder Claude Code has never been opened in is refused by `claude --bg` until you have run `claude` there once and said yes to the question about trusting it. Togle says so, and nothing is started.
- Togle hears a task by an address on this computer that Claude Code was given when the session started, and a running session keeps it. The address, a secret, and each task's settings file are kept in Togle's data folder (`claude/`), so the same address is served again when Togle starts. If another program has taken that port meanwhile, a task still running from before cannot be heard: its row says what it waits for, and it is answered on its screen. One that is stopped and opened again gets the new address. Taking a task out of Claude Code (`claude rm`) removes it from Togle too; its settings file goes with it.
- While Togle is closed, nothing is shown for a question: Claude Code asks on its own screen, and prints no error for the address that is not there. A request that came then is not posted again when Togle starts: the task's row says it waits on its screen, the tray counts it and a notice says so, and it is answered on its screen. Togle has no card for it.
- A background session is a program that stays until it is stopped, even when its turn is over. Stop the ones you are done with, or leave them: opening a task whose session ended brings it back.
- A task whose words are longer than 20,000 characters is refused: they go in the command that starts it.
- Take over is for Claude Code only. A Codex or Hermes session that runs in your own terminal is opened from the list instead (see below).

## Codex's own screen

A Codex task opens in Togle as **Codex's own screen**: `codex resume <thread>` in a terminal of Togle's own, with its keys and commands as in your terminal. The task is a thread on **Codex's shared server**. Codex keeps one server per computer (its "daemon") that every `codex` joins, and a thread goes on in it whether or not a screen is open. Togle is a second client of that server beside the screen, which is how it hears what the thread does and what it asks. What Togle adds is around the screen:

- The task is in the list, **Working** while it answers and **Done** when it has. A notice says when it is done.
- When Codex asks to run a command or change files, a card shows it above the screen: **Allow once** and **Refuse**, and **Always allow** with the words the commands start with. The screen asks at the same time. Either is enough: answer in Togle or on the screen, and the other is told it was answered, so the card goes at once.
- Nothing is forced on it. It starts with your own settings. Yours may never ask, and then no card shows.
- **It goes on without Togle.** Closing its screen does not stop it, and neither does quitting Togle: its commands keep running and the turn goes on to its answer, with nobody connected. A question that is open when Togle quits stays open on the server, and the next Togle, or the screen, is asked again. When Togle starts, it finds the tasks it ran that are working or waiting.
- **Stop** ends the turn, as Esc does on the screen. A command that was already running goes on, and a stopped task shows **End the running command** for it.
- **Hand back** closes the screen here and gives you the line to open it in your own terminal: `codex resume <thread>`. A thread that runs in a terminal of your own is in the list too; opening it joins it, and both screens show it.
- Your other devices list the task. They can **Refuse** a command and **Stop** the task, and never type into the screen.

The shared server is Codex's own, and Togle only joins it. It starts it when you start a task, as `codex` does when you run it, and does not start it to list your tasks (they are read from a server of Codex's own, apart from it, while the shared one is not running). The server keeps itself up to date: it may fetch a new release, which is large (about half a gigabyte on this computer), and restart. Togle looks for it again when it does, and a task that was running then is taken up again if it still works. Togle reaches it through `codex app-server proxy`, which Codex offers for this and calls experimental.

Some limits, as Codex 0.169 (the server) with 0.166 (its screen) has them on Windows:

- `/new` on the screen starts another thread in the same program. The task in Togle stays with the first.
- A thread has to have had its first message before it can be joined: a task is started with its words.
- **End the running command** finds the command by its text among what Codex's server runs, so it also ends an identical command that another thread of the server is running.
- Mac and Linux were not tried.

## Hermes's own screen

A Hermes task opens in Togle as **Hermes's own screen**: `hermes --tui` in a terminal of Togle's own, with its keys and commands as in your terminal. Hermes follows your own settings: Togle gives the screen no flag. The conversation is not in the screen. It is a session in the **Hermes gateway**, the background process that serves its messaging platforms (or one a screen starts, which ends itself after ten idle minutes), so it goes on when the screen closes. What Togle adds is around the screen:

- The task is in the list, **Working**, **Waiting** and **Done**, for as long as its screen is open. Togle reads the screen's window title, which Hermes sets to ⏳ while it works, ⚠ while it waits on an approval, a password or a question, and ✓ when it is idle. A notice says when a turn is done, and a task that waits says it waits on its screen.
- What Hermes asks is answered on its screen. Togle has no card for it: Hermes tells nothing else while a screen holds its session. With its approvals turned off, Hermes never asks.
- **Stop** is Ctrl+C on the screen: Hermes ends the turn and the command it was running. If the screen is closed, Togle opens it first.
- **It goes on without the screen.** A turn goes on when the screen is closed or Togle is quit, and writes its answer: Hermes's gateway ends a turn only when it has had no news for ten minutes. A session with no turn is let go of by the gateway after twenty seconds, and opens again from Hermes's store. While the screen is closed Togle does not know what the session does: the task rests in the list, and **Open the screen** brings the session back with its history.
- **One screen at a time.** Hermes refuses to open a session that another window holds, and says so on the screen; Togle shows the words.
- A new session is named as the task's words, so that Hermes's own list reads as Togle's does (Hermes keeps one session to a name: a name it already has gets a number, `#2`, as Hermes does itself). A session whose first turn failed, because its model did not answer, is in Hermes's list with no folder, and is found all the same. The sessions in the list are Hermes's own, from its terminal and its screens (not its messaging platforms or scheduled jobs). Hermes's list says only the folder's name, so **See changes** has no folder for one Togle did not start.
- Your other devices list the task and can **Stop** it. There is no card for them to refuse.

Some limits, as Hermes 0.22.5 has them on Windows:

- Togle hears the title only while the screen is open. After a restart of Togle, a Hermes task is a row in the list, not a task Togle hears; a to-do line that names the task still finds that row.
- Hermes's own list does not say which sessions are running.
- Closing the screen of a Hermes task while its turn works makes the task read Done in Togle, and a notice that it finished may show, though the turn goes on in Hermes.
- When no Hermes gateway runs, the screen starts one; whether closing the screen ends that gateway, and the turn with it, was not tried.
- Hermes prints a title cut at 26 characters, so a session taken from its list shows a short title until its screen is opened.
- Mac and Linux were not tried.

An earlier development build of Togle could add an entry to Claude Code's settings that started Togle as `--togle-hook`. That entry now does nothing; take it out of `~/.claude/settings.json` if it is there.
