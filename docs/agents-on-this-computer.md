# Coding agents on this computer

Togle lists the tasks of the coding agents on your computer (Claude Code, Codex and Hermes) in one place, and lets you answer what they ask. It starts each agent's own program and talks to it the way the agent's own editor extension does. It never reads their sign-ins.

## Tasks

The **Tasks** button in the sidebar opens the list. A task that waits for you comes first, with the command it wants to run shown in full.

- **Allow once** lets that one command run. **Refuse** tells the agent no.
- A command that looks dangerous (it deletes for good, pushes over what is on a server, runs hidden text, changes the computer) carries a red mark and the reason. The mark is a hint. The command shown is what runs.
- **New task** starts a task in a folder with one of the agents. A task started here asks before every command and every change.
- **Stop** stops a task. Codex lets a command that was already running finish, so a stopped Codex task shows a second button, **End the running command**.
- **Let go** stops Togle running a task. The task stays on the computer, and **Continue here** picks it up again.
- A task that runs in a terminal or in an app shows in the list too. For Claude Code, **Take over** ends the program in the terminal and carries the conversation on here. Togle asks first.
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

**F10** opens a small box over whatever you are doing. Pick the agent and the folder, type the task (or hold the dictation key and say it), and press Enter. It starts the task like **New task** does, and puts itself away. **Esc** closes it, and so does a click elsewhere; what you typed stays for next time, and so do the agent and folder you picked. The key is a setting like the others (**Settings → Coding agents**, or **Window & shortcuts**), and F10 can be changed there if another program needs it.

## Settings

**Settings → Coding agents** has the two notices (a task waits, a task finishes), the task box key, the Claude Code connection below, and where the to-do file is.

## To-do

The **To-do** button opens your list. What waits for you is at the top, with the same buttons as in Tasks. Below it is your own list.

The list is a plain text file you can also open in any editor: `to-do.md` in Togle's data folder (`%APPDATA%\togle` on Windows; **Show the file** opens it). Each item is a line of a Markdown checklist:

```
- [ ] Review the onboarding copy
- [ ] Fix the login redirect <!-- togle:task=claude:3f2a9c1e -->
- [x] Send the invoice to Marta
```

Lines that are not items are left as they are. An item given to an agent keeps the task in the comment at its end. A change in an editor shows in Togle, and a change in Togle names the item by its line and its words, so it cannot land on another item if the file was edited meanwhile.

**Give to an agent** opens the New task form with the item's words filled in. The item then shows what the task is doing, and **See changes** when it has finished. You tick the item yourself once you have looked.

## From a terminal

The `togle` command starts a task in the running Togle from any terminal, and lists the tasks:

```
togle run --agent codex --folder ./api "Add a status column to the orders table"
togle run "Fix the failing login test"        # Claude Code, in the current folder
echo "Review the onboarding copy" | togle run  # piped text is the task
togle tasks
```

The task shows in Tasks like any other and asks before every command and every change. The command talks to Togle over the same local channel as the Claude Code hook below, so it needs Togle running, and it says so when it is not. It exits with 0 when it worked, 1 when Togle could not do it, and 2 when the command was not understood.

The command is the program `out/main/cli.js`, started by Electron as plain Node (`ELECTRON_RUN_AS_NODE=1`). Putting a `togle` on your path comes with the installer. From a development run, name the data folder: `TOGLE_DATA`.

## Claude Code in a terminal

Claude Code asks the person at its terminal. With Togle connected, it also asks Togle, so you can answer from a notice or from this window. Either answer counts, and the first one wins. In a test with a real Claude Code session, the terminal's own question appeared at the same time as Togle's notice, an answer in the terminal worked while Togle's notice was still up, and an answer in Togle ended the terminal's question.

Connect it from **Tasks → Connect Claude Code**. This adds one entry to Claude Code's settings file (`~/.claude/settings.json`, or the folder named by `CLAUDE_CONFIG_DIR`). The first time, a copy of the file is kept beside it as `settings.json.togle-backup`. A file that is not valid JSON is left alone. **Turn off** takes Togle's entry out again and leaves the rest. It needs Claude Code 2.1.139 or later.

How it works:

- Claude Code starts Togle as `Togle --togle-hook claude-permission --data <Togle's data folder>` for each question. That short run does not open a window. It hands the question to the running Togle, waits for your answer, prints it the way Claude Code takes it, and exits. It takes about a tenth of a second to start.
- If Togle is not running, or does not answer, the hook prints nothing and Claude Code asks in the terminal as it always did.
- Togle listens on a named pipe on Windows and a socket file elsewhere. Both ends hold one secret, kept in a file only you can read (`channel/secret` in Togle's data folder), and each proves it holds it before anything else is said. A program that took the pipe's name before Togle did cannot answer a hook, so it cannot allow a command, and it is never sent the command. This has not had an outside security review.
- A question goes away from Togle when it is answered in the terminal: Togle sees the session's transcript grow, or the session stop waiting.
- To see what a hook did, start Claude Code with the environment variable `TOGLE_HOOK_LOG` set to a file name.

`npm run test:claude-hook:live` runs this against a real Claude Code session in a terminal. It needs [node-pty](https://github.com/microsoft/node-pty), which Togle does not depend on: install it in a folder of its own and name that folder in `TOGLE_PTY_MODULE`.
