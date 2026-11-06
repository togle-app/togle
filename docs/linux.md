# Togle on Ubuntu

Build on Ubuntu with Node 24 (`.nvmrc`) and the target CPU architecture's native dependencies. Togle hears the other
side of a call through the monitor of the speakers that PulseAudio, or PipeWire's PulseAudio service, lists as an input;
no audio driver or module is added.

```sh
npm ci
node node_modules/electron/install.js
npm run dist -- --linux
```

Outputs include a `.deb`, an AppImage and `dist/linux-unpacked`. Do not relabel an x64 build as arm64. Current Ubuntu CI
targets x64.

Removing background noise from your microphone for every call app is Togle Microphone's job, a separate app. When it's
installed, Togle finds it by itself, shows whether it's on, and can turn it on for calls (Settings → Togle Microphone).

```sh
# Requires an ordinary desktop or Xvfb and a working audio service.
npm run test:linux
```

The Ubuntu workflow runs with PulseAudio and with PipeWire. It checks the build, unit tests, the UI and native IPC, the
tray and the dictation UI, and the packaged app. Logs, reports, installers and failure screenshots are workflow
artifacts. Require every check to pass, `complete: true` and `sourceUnchanged: true`. Verification reports are separate
from installers and retained for 14 days. Installers are uploaded only after every check passes.

The desktop fixtures use synthetic audio and silent output. Physical USB/Bluetooth devices, hotplug, permissions and
Wayland desktop capture still need native hardware checks. Linux dictation uses press-to-start/stop and copy/paste;
Windows hold-to-speak insertion is a separate platform path.
