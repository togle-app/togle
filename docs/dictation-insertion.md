# Windows dictation insertion

Hold F9, speak, and release to enter text into the focused editable field. Recognition and cleanup still use the selected subscription. This change concerns delivery to the desktop editor.

## Editor compatibility

Editable fields receive one native paste, so the editor's own paste/input handlers process Unicode, paragraphs and tabs. Togle eagerly snapshots the existing clipboard's payload formats before publishing temporary text, then restores them after delivery. A clipboard sequence and an ownership marker prevent restoration from overwriting a newer copy. Temporary text opts out of Windows clipboard history and cloud clipboard upload. If the existing clipboard cannot be preserved, ordinary single-line text can use Unicode keyboard delivery without modifying it.

Terminal destinations retain Unicode keyboard delivery. Line breaks, tabs and other control characters are rejected before sending any terminal input. Togle never presses Enter to submit a message or execute a command.

Before delivery, Togle checks the original window, focused control and the exposed content/selection. It checks again after clipboard preparation. Changed destinations retain the recognized text for recovery. Delivery is a single attempt: an uncertain or rejected paste never triggers another paste or a second typing attempt.

Empty rich editors can expose a placeholder newline through Windows accessibility and remove it once input arrives. Virtualized Markdown editors can also change their accessible document representation on redraw. Confirmation uses the expected value and a bounded text range immediately behind the caret, including normalized paragraph boundaries, to avoid falsely reporting failure after successful input.

## Verification

Run `npm run test:dictation:editors` on an unlocked Windows desktop while leaving the keyboard idle for about 20 seconds. The suite uses a disposable Electron window with actual CodeMirror, native Windows input and the production insertion helper. It never opens a user vault or sends text to a real account.

The 18 insertion cases cover empty and existing notes, selection replacement, mixed scripts/emoji, blank lines, paragraphs, CRLF, tabs, whole-note replacement, a large virtualized document, contenteditable/textbox/document roles, plaintext editing, shadow DOM, and an editor that rejects Unicode typing. Additional checks cover changed cursors, read-only editors, preserved clipboard payloads, copies made during delivery, a rejected paste, and the absence of Enter/Tab key presses. Clipboard assertions contain hashes rather than user clipboard content.

`npm run test:dictation:native` additionally checks standard inputs, passwords/read-only fields, focus changes, the production bar, physical F9 release, and an isolated console input fixture that cannot execute commands.

These tests verify the insertion path and editor behavior, not every application or extension. The current Obsidian installation still needs a user check because desktop inspection is unavailable in this session. Elevated applications and controls that deliberately reject paste or expose no reliable editable surface can still require recovery.
