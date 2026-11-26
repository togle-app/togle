# Togle for Android and iOS

Togle’s React Native app for following paired devices. Sign in with your Togle account. On the managing computer, open Togle → Settings → Devices → Add a device. In Agents on your phone, select **Scan QR code**, point the camera at the invitation, then approve the phone on the computer. Agents shows the sessions shared by devices in the group that approved the phone. To-do opens a session in Agents when it has a question you can answer.

**Paste invitation** accepts the text from the computer’s QR screen. **Show pairing code** displays a short code you can enter on the computer. Both options work without camera access. The Android scanner uses Google Play services. On iOS the scanner uses VisionKit on supported devices and asks for camera access when you scan.

Personal to-dos are saved on the phone for the signed-in account. The Agents and To-do tabs keep their place when you switch between them. With activity sharing enabled on an online host, a session shows its recent conversation, work summaries, model and measured usage. With provider-wide usage enabled on the host, Agent usage shows the host's readings for each agent and expandable account limits, with reset countdowns where reported.

The build uses Togle’s encrypted device connection. The phone can answer a listed Codex question, send a chat message, manage queued messages and stop an eligible session when the test computer allows those actions. One check shows that the host received the message. Two show that it reached the agent.

The mobile client is open source under the repository’s [MIT license](../LICENSE). The hosted device relay requires a Togle account enabled for remote access. Your managing computer must approve the phone before it can see sessions or take actions. Hosted access is a Togle Pro feature and is currently available to approved beta testers.

## Build Android

Use Node 22.13+, 24.3+, or 26+, and JDK 17. Install Android Platform Tools, Android API 36, Build Tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1. Run `npm ci` from `mobile/`.

You can build the app with no service configuration. To sign in and connect to devices, set the following environment variables and run `npm run configure`.

| Variable | Value |
| --- | --- |
| `TOGLE_ACCOUNT_SUPABASE_URL` | Togle account service origin |
| `TOGLE_ACCOUNT_SUPABASE_KEY` | Account service publishable or anon key |
| `TOGLE_MOBILE_RELAY` | Togle device relay WebSocket endpoint at `/v1` |

From `mobile/android`, run `./gradlew :app:assembleDevelopment` (`gradlew.bat` on Windows). This bundles the JavaScript into an APK in `app/build/outputs/apk/development/`. The development package ID is `app.togle.mobile.dev`. Pass `-PreactNativeArchitectures=x86_64` for an x86-64 emulator-only build.

Pass `-PtogleDevelopmentSuffix=.qrdev` to build **Togle QR Development** alongside an installed development app. Its separate Android application ID keeps its sign-in and pairing state separate.

For a loopback smoke test, configure with `npm run configure -- --development` using `127.0.0.1` addresses and forward the authentication and relay ports with `adb reverse`. Run the test desktop with `TOGLE_PHONE_PILOT=1` and `TOGLE_PHONE_PILOT_FOLDER` pointing to the isolated task folder. Set `TOGLE_PHONE_PILOT_ACTIVITY=1` for session activity and usage, `TOGLE_PILOT_ACCOUNT_USAGE=1` if the host should also share provider-wide totals and limits, and `TOGLE_PHONE_PILOT_MESSAGES=1` for the chat composer and task controls. Turn on remote actions in the desktop’s device settings.

## iOS

The iOS project uses the same React Native screens and connection. On macOS with Xcode, run `npm ci` and `bundle install` from `mobile/`, then `bundle exec pod install` from `mobile/ios/`. Set the service addresses as above and run `npm run ios` from `mobile/` to launch a simulator build.

## Third-party notices

- [React Native app template](licenses/react-native-template.txt)
- [Agent icons](assets/icons/agent-icons.txt)
- [Feather](licenses/feather.txt) and [Lucide](licenses/lucide.txt) interface icons
- [Inter](android/app/src/main/assets/fonts/OFL-Inter.txt) and [Bricolage Grotesque](android/app/src/main/assets/fonts/OFL-Bricolage-Grotesque.txt) fonts
