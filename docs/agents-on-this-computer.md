# Coding agents on this computer

Togle lists the tasks of the coding agents on your computer (Claude Code, Codex and Hermes) in one place, and lets you answer what they ask. It starts each agent's own program and talks to it the way the agent's own editor extension does. It never reads their sign-ins.

## Agents

**Agents** in the sidebar opens the list. A task that waits for you comes first, with the command it wants to run shown in full.

- **Allow once** lets that one command run. **Refuse** tells the agent no.
- **Always allow…** shows when the agent offers to remember the choice, and says how far it reaches: for Claude Code, the rule it suggests and where it keeps it (this task, this project, or everywhere); for Codex, the words the commands start with, wherever they run; for Hermes, its own option. Togle passes on only that, never a change of the agent's permission mode. It is not offered for a command that looks dangerous, nor in a notice.
- An open task starts with what the agent said last and how many files it changed; its steps and the conversation fold under one line ("5 steps: ran 3 commands, changed 2 files").
- A command that looks dangerous (it deletes for good, pushes over what is on a server, runs hidden text, changes the computer) carries a red mark and the reason. The mark is a hint. The command shown is what runs.
- **New task** opens the task box (below). A task started in Togle asks before every command and every change.
- **Stop** stops a task. Codex lets a command that was already running finish, so a stopped Codex task shows a second button, **End the running command**.
- What finished in the last day stays in the list; older tasks fold under **Earlier**.
- A task that runs in a terminal or in an app shows in the list too. For Claude Code, **Take over** ends the program in the terminal and carries the conversation on here. Togle asks first.
- A task that stops by itself (a turn that ends with an error, or an agent program that stops) waits for you like a question, and its row says why. When the error means the agent is signed out, the row says so with the command that signs it in again (`claude auth login`, `codex login`, `hermes model`) and **Copy**: run it in a terminal, then reply to go on. The words that count as signed out are in `isSignedOut` in `src/shared/runner.ts`; Claude Code's and Codex's were seen on this computer, Hermes's were not.
- With no agent installed, Agents names Claude Code, Codex and Hermes, each with the one line its maker gives to install it and a link to its page. Togle looks for agents the way a terminal would: when one is not found, it adds the PATH saved in the registry (Windows) or the one the login shell sets up (Mac and Linux), so an agent installed while Togle runs shows within a minute. The login shell runs your start-up files, so Togle asks it at most every ten minutes, with no input, and stops it after five seconds; the usual folders (`~/.local/bin`, Homebrew's, `/usr/local/bin`) are checked every time.
- **See changes**, beside a task's name, lists what differs from the last commit in its folder and shows each file's diff. It is read with git. It shows everything in the folder that differs, which can include changes that did not come from the agent.
- Quitting Togle while a task it runs has not finished asks first. If you quit, the task and the commands it started are stopped.

Hermes asks about a command only when its own settings say to. With its approvals turned off, it never asks, and there is nothing to answer.

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

The task shows in Agents like any other, goes on the to-do list, and asks before every command and every change. The command talks to Togle over a local channel (a named pipe on Windows, a socket file elsewhere), where both ends prove they hold a secret kept in Togle's data folder, so it needs Togle running, and it says so when it is not. It exits with 0 when it worked, 1 when Togle could not do it, and 2 when the command was not understood.

The command is the program `out/main/cli.js`, started by Electron as plain Node (`ELECTRON_RUN_AS_NODE=1`). From a copy of the source, run `npm run build`, then `node bin/togle.cjs tasks`, or `npm link` to get `togle` on your path. An installed Togle has the command beside the app in `resources/bin` (`togle.cmd` on Windows, `togle` on Mac and Linux); add that folder to your path to use it from anywhere. The installer does not add it yet, and the Mac and Linux versions were not tried. From a development run, name the data folder: `TOGLE_DATA`.

## A task you started in a terminal

A Claude Code session you started yourself in a terminal shows in Agents with its state, and its row offers **Take over**. Take over ends the program in the terminal and carries the conversation on in Togle, where you answer it; Togle asks first. `togle run claude` starts one in Togle from the beginning. Togle doesn't answer a session where it runs.

An earlier development build of Togle could add an entry to Claude Code's settings that started Togle as `--togle-hook`. That entry now does nothing; take it out of `~/.claude/settings.json` if it is there.
