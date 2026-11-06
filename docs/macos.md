# Togle on macOS

Use macOS 14.2 or later for native system-audio capture. Build on the architecture you want to ship: Apple silicon (`arm64`) or Intel (`x64`). The app uses Electron, the official Claude runtime, Sherpa ONNX and Koffi native binaries for that architecture. An Apple-silicon build must not be relabeled as an Intel build.

## Build and run

Use Node 22.12 or later; `.nvmrc` selects Node 24 for development and CI. Packaging also uses Apple's Command Line Tools for `lipo` (`xcode-select --install` if they are missing).

```sh
nvm use
npm ci
node node_modules/electron/install.js
npm run dev
```

The explicit Electron install downloads the runtime before the first launch. It is useful when dependencies were installed without network access or before the runtime was cached. No local Whisper installation is needed to open Togle.

For a packaged app on the current Mac:

```sh
npm run pack -- --mac
npm run open
```

Apple silicon produces `dist/mac-arm64/Togle.app`; Intel produces `dist/mac/Togle.app`. `npm run dist -- --mac` makes a DMG and a ZIP for the same architecture. Togle installs no audio driver: it hears the other side of the call through macOS's own system-audio capture. Run these builds on matching Macs with matching Node installations and native dependencies. Build and test the other architecture separately. Cross-compilation and universal bundles are not verified by this workflow.

Packaging automatically verifies build provenance and resources, then checks the actual Mach-O architectures of Electron, its framework, Claude, Sherpa ONNX and Koffi. It also verifies the native Togle icon, minimum macOS version and microphone/system-audio descriptions in `Info.plist`. To repeat the Mac bundle checks independently:

```sh
node scripts/verify-macos.cjs dist/mac-arm64/Togle.app arm64
# Intel: node scripts/verify-macos.cjs dist/mac/Togle.app x64
```

These are development builds. Distribution with Developer ID signing and Apple notarization requires the maintainer's Apple Developer credentials and a separate release setup. The verification does not establish notarization.

## Permissions and behavior

- **Microphone:** start a call or dictation and allow the macOS prompt. If denied, use System Settings → Privacy & Security → Microphone, then quit and reopen Togle.
- **System audio and screen context:** allow the relevant prompts when starting a call or selecting a screen. Check System Settings → Privacy & Security → Screen & System Audio Recording if capture is unavailable. Development runs can appear as Electron; the packaged app appears as Togle. Test the packaged app's permissions separately.
- **Screen sharing:** modern apps using ScreenCaptureKit can capture Togle even when Hide from screen sharing is enabled. Share a specific call or document window rather than relying on that setting. Togle's own snapshots mask its window when capture exclusion cannot be verified. The call indicator only claims verified capture hiding on Windows.
- **Dictation:** the Mac uses press-to-start/stop and offers **Copy text** for pasting into the destination app. Automatic insertion and hold-to-speak remain Windows-only. No Accessibility permission is required for this copy workflow. F9 may require Fn; choose another shortcut in Settings if macOS uses it.
- **Shortcuts:** the default call shortcuts use Control + Option (shown as Ctrl + Alt). The native Edit menu provides Command + C/V/X/A and undo/redo. Command + W follows the window's normal close-to-menu-bar behavior; Command + Q uses Togle's existing confirmation and save flow.
- **Local speech:** choose On this device under Settings → Speech → Advanced speech settings → Call transcription, then install it there. `npm run setup:whisper` is a Windows-only development helper.

## Verification

For a single command that runs the complete suite and creates the DMG and ZIP, quit Togle, stop any dev server with Ctrl+C, then run this in a normal Mac terminal:

```sh
npm run test:macos
```

It continues through independent checks after a failure and saves each command's output and a JSON report in `test/.work/macos/`. A report only establishes success when every check passes, `complete` is true, and `sourceUnchanged` is true. The runner uses isolated fixtures and disables automatic discovery of signing identities for the development package. GUI tests may abort before startup in an agent sandbox even when Electron runs correctly from Terminal.

Run the deterministic checks without signing into a provider:

```sh
npm run typecheck
npm test
npm run test:ui
npm run test:native
npm run test:tray
npm run test:dictation:ui
npm run pack -- --mac
```

The native and UI suites use isolated test profiles and scripted accounts, transcripts and audio. They cover the production renderer, IPC, OS encryption, saved calls and the native Mac Edit menu without using real provider credentials or recording the microphone. The UI fixture uses the host platform so Mac-specific settings and copy behavior are exercised. One unit test binds a loopback WebSocket server; a sandbox that forbids local listeners cannot run that test.

The macOS GitHub Actions workflow builds separately on Apple silicon and Intel. It runs type checking, unit tests, UI/native integration, tray and dictation UI checks, and DMG/ZIP packaging. The installers and reports are separate workflow artifacts, retained for 14 days; installers are uploaded only after every check passes. It runs for pull requests, pushes to `main`, and manual dispatch. Check both reports; a successful build does not certify physical audio hardware.

Removing background noise from your microphone for every call app is Togle Microphone's job, a separate app with its own driver. When it's installed, Togle finds it by itself, shows whether it's on, and can turn it on for calls (Settings → Togle Microphone).

Before treating a build as ready for daily calls, complete these checks on the packaged app:

1. Open the app, edit text with Command shortcuts, close and reopen it from the menu bar and Dock, and quit during an active call to check confirmation and recovery.
2. Grant microphone and screen/system-audio access. With headphones, confirm independent Mic and System audio levels and transcripts. Deny a permission, verify the explanation, then grant it and retry after restarting.
3. Select a specific window and a Retina screen for context. Confirm the intended source and test an external display if available.
4. Connect the provider you intend to use. Verify replies, saved-call questions, and press-to-start/stop dictation followed by Copy text and paste into another app.
5. If using local speech, install and exercise the Metal Whisper framework and Parakeet on a real recording.

Live audio, provider sign-in, model downloads, screen permissions and Intel execution require these additional checks; passing scripted tests alone does not verify them.
