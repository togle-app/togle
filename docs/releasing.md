# Releasing Togle

Every update is signed with Togle's release key, and Togle checks the signature before it installs anything. The key
is kept off every server and off the computers that build Togle. Its public half is published, so anyone can check a
download.

## The key, once

On Windows, the build PC can prepare a portable maintainer kit with `node scripts/package-offline-signer.mjs`. Transfer the ZIP from `dist-release-tools/` to a separate Windows PC of the same architecture that stays offline. Extract the ZIP into a writable folder and double-click **Togle release signing.cmd**. Bring back the **togle-release.pub** file beside the launcher. The private key stays in the offline PC's local Windows profile. When the installer is ready, drag it onto the same launcher on the offline PC to produce and verify its `.sig` file.

For an offline computer that already has Node, the equivalent key-generation command is

```sh
node scripts/release-key.mjs keygen <a folder on an offline drive>
```

This writes `togle-release.key` (the private half: keep it offline, with a copy somewhere safe) and `togle-release.pub`.
Put the contents of `togle-release.pub` into `src/main/release-key.ts` and include the public key on the release page. Until that file
holds a key, Togle doesn't look for updates.

## First Windows beta on GitHub

GitHub Releases can serve the entire Windows install, including before the Togle website goes live. Use the public `togle-app/togle` repository.

1. Choose the beta version, commit the source and its public release key, and build the Windows installer from that commit. Tag that same commit. The example below uses `v0.1.0-beta.1`.
2. Sign the final Windows installer on the computer that holds the offline key. The `sign` and `verify` commands below create and check its matching `.exe.sig`.
3. Generate the install script using the public key and the exact release tag.

   ```sh
   node scripts/release-key.mjs installers togle-release.pub beta-install v0.1.0-beta.1
   ```

4. Create a GitHub prerelease for that tag. Attach the Windows setup `.exe`, its matching `.exe.sig`, and the generated `beta-install/install.ps1` (uploaded as `install.ps1`). Publish it when ready for testers. An anonymous visitor can then install from a fresh Command Prompt with the line below. Substitute the published tag when it differs.

   ```cmd
   powershell -NoProfile -Command "iex (irm https://github.com/togle-app/togle/releases/download/v0.1.0-beta.1/install.ps1 -ErrorAction Stop)"
   ```

Copy the command into the published release notes. Verify it from a signed-out Windows PC. Set `TOGLE_INSTALL_DRY_RUN=1` beforehand for a download and signature check, or leave it unset for a per-user installation.

The tag matters because GitHub's latest-release endpoint skips prereleases. For the stable website command, generate the scripts without a tag so they follow the latest stable release. [GitHub release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)

## Each release

1. Build each system's packages as its guide says (`npm run dist`, and on a Mac `npm run dist -- --mac`).
2. On the computer that holds the key, sign every file the release offers:

   ```sh
   node scripts/release-key.mjs sign togle-release.key "Togle Setup 0.2.0.exe" Togle-0.2.0-arm64-mac.zip Togle-0.2.0-mac.zip Togle-0.2.0.AppImage
   ```

   Each file gets a `.sig` beside it. Upload both to the GitHub release. A build without its `.sig` is never installed:
   not by the install commands, not by Togle's own updates.
3. Generate the install scripts using the public key. After the signed Windows installer and its matching `.sig` are available in the latest public GitHub release, copy the generated `install.ps1` to `web/togle.app/install.ps1` in the website repo (`LukaDut7/togle`). Commit that public script and deploy the main site. Stage `install.sh` there when its Mac and Linux downloads are ready. The website build includes the staged scripts and enables their install commands.

   ```sh
   node scripts/release-key.mjs installers togle-release.pub <folder>
   ```

4. Check one download with `node scripts/release-key.mjs verify togle-release.pub "Togle Setup 0.2.0.exe"`. These commands verify the deployed Windows download and signature in Command Prompt without installing.

   ```cmd
   set "TOGLE_INSTALL_DRY_RUN=1"
   powershell -NoProfile -Command "iex (irm https://togle.app/install.ps1 -ErrorAction Stop)"
   set "TOGLE_INSTALL_DRY_RUN="
   ```

## What runs where

| | Install | Update |
| --- | --- | --- |
| Windows Command Prompt | `powershell -NoProfile -Command "iex (irm https://togle.app/install.ps1 -ErrorAction Stop)"` checks the installer with PowerShell's own RSA, then runs it quietly for the current user. | Togle checks the installer, then runs it quietly once it has quit; it opens again |
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
