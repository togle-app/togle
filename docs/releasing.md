# Releasing Togle

Every update is signed with Togle's release key, and Togle checks the signature before it installs anything. The key
is kept off every server and off the computers that build Togle. Its public half is published, so anyone can check a
download.

## The key, once

```sh
node scripts/release-key.mjs keygen <a folder on an offline drive>
```

This writes `togle-release.key` (the private half: keep it offline, with a copy somewhere safe) and `togle-release.pub`.
Put the contents of `togle-release.pub` into `src/main/release-key.ts` and publish them on togle.app. Until that file
holds a key, Togle doesn't look for updates.

## Each release

1. Build each system's packages as its guide says (`npm run dist`, and on a Mac `npm run dist -- --mac`).
2. On the computer that holds the key, sign every file the release offers:

   ```sh
   node scripts/release-key.mjs sign togle-release.key "Togle Setup 0.2.0.exe" Togle-0.2.0-arm64-mac.zip Togle-0.2.0-mac.zip Togle-0.2.0.AppImage
   ```

   Each file gets a `.sig` beside it. Upload both to the GitHub release. A build without its `.sig` is never installed:
   not by the install commands, not by Togle's own updates.
3. Write the install scripts with the key in, and publish them on togle.app as `install.ps1` and `install.sh`:

   ```sh
   node scripts/release-key.mjs installers togle-release.pub <folder>
   ```

4. Check one download yourself: `node scripts/release-key.mjs verify togle-release.pub "Togle Setup 0.2.0.exe"`.

## What runs where

| | Install | Update |
| --- | --- | --- |
| Windows | `irm https://togle.app/install.ps1 \| iex`: checks the installer with PowerShell's own RSA, then runs it quietly, for this user only | Togle checks the installer, then runs it quietly once it has quit; it opens again |
| Mac | `curl -fsSL https://togle.app/install.sh \| sh`: checks the zip with openssl, then puts Togle in `~/Applications` | Togle checks the zip and shows it, to open |
| Linux | the same command: checks the AppImage, then puts it in `~/.local/share/togle` with a menu entry | Togle checks the AppImage, replaces itself and starts again |

`--connector` (Togle for a server) is not released yet: it comes with Togle Studio's devices.

## winget and Homebrew

`winget install togle` and `brew install togle` need Togle listed there: a manifest in microsoft/winget-pkgs (the
installer's address and its SHA-256) and a cask in Homebrew. Both point at the signed files of the GitHub release.
The installers also need Windows code signing (Authenticode) and Apple's Developer ID with notarization, which take
the maintainer's own certificates.

Signatures are RSA-3072 with SHA-256 (PKCS #1 v1.5), which Windows PowerShell 5.1, openssl and Node all check without
anything to install. `npm test` runs both install scripts against a stand-in release (`test/install-scripts.test.mjs`).
