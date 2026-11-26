# Releasing Togle

Every update is signed with Togle's release key, and Togle checks the signature before it installs anything. The key
is kept off every server and off the computers that build Togle. Its public half is published, so anyone can check a
download.

## Togle account sign-in and the Pro waitlist

Build each desktop installer with `TOGLE_ACCOUNT_SUPABASE_URL` and `TOGLE_ACCOUNT_SUPABASE_KEY` set to the shared Studio account project's HTTPS origin and public publishable key (or legacy anon key). The main-process build embeds these values. An unconfigured build supports local work and shows that account sign-in is unavailable. Set both values before publishing a release that advertises sign-in.

On that project, configure email OTP, allow the redirect URL `https://togle.app`, and install the shared Togle confirmation and sign-in email templates. The desktop asks for this redirect to select its code-only email. Apply the authenticated `my_pro_waitlist`, `join_pro_waitlist` and `leave_pro_waitlist` RPCs. Verify a fresh sign-in, joining, leaving and sign-out in Settings → Accounts. The account service is independent of the development courier.

For a development run, point the same two variables at a local Supabase project. Loopback HTTP is accepted in development. To exercise the built app against local Supabase and Mailpit, set `TOGLE_ACCOUNT_MAILPIT_URL` as well, then run `npx --no-install electron test/account-local.cjs` from the project with its built Electron output available.

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

## Togle Beta builds

Starting with `v0.1.0-beta.5`, build prereleases with `TOGLE_RELEASE_CHANNEL=beta` and the exact prerelease version in
`package.json` and `package-lock.json`. Togle Beta has its own app identity, application data, and menu entry. The
installed command is `togle-beta`. Stable builds use the regular Togle identity and `togle` command.

```powershell
$env:TOGLE_RELEASE_CHANNEL = 'beta'
npm run dist -- --win --x64 --config.directories.output=dist-beta
Remove-Item Env:TOGLE_RELEASE_CHANNEL
```

```sh
TOGLE_RELEASE_CHANNEL=beta npm run dist -- --linux AppImage --x64 --config.directories.output=dist-beta
```

The public asset names still follow `Togle.Setup.<version>.exe` and `Togle-<version>.AppImage`. Installing from the
beta shell command places the Linux app in `$XDG_DATA_HOME/togle-beta`, or `~/.local/share/togle-beta`, with a separate
**Togle Beta** launcher. The stable install remains available from **Togle**. The first four published beta builds
used the regular install identity and keep that behavior when their install scripts are regenerated from the tag.

## Each release

1. Build from the commit at the release tag. Use `npm run dist -- --linux AppImage --x64` on an x64 Linux system. Follow the [macOS distribution steps](macos.md#distribution) for Apple silicon and Intel ZIPs.
2. On the computer that holds the key, sign every file the release offers:

   ```sh
   node scripts/release-key.mjs sign togle-release.key "Togle Setup 0.2.0.exe" Togle-0.2.0-arm64-mac.zip Togle-0.2.0-mac.zip Togle-0.2.0.AppImage
   ```

   Each file gets a `.sig` beside it. Upload both to the GitHub release. A build without its `.sig` is never installed:
   not by the install commands, not by Togle's own updates.
3. Generate the PowerShell and shell scripts with the same public release key. Pin the beta scripts to the tested beta tag. Generate the stable scripts without a tag so they follow GitHub's latest stable release. Copy the generated files to the `beta/` and `stable/` folders in the [install channel deployment](https://github.com/togle-app/togle/tree/deploy/windows-install-channels/install/channels).

   ```sh
   node scripts/release-key.mjs installers togle-release.pub <beta-folder> <beta-tag>
   node scripts/release-key.mjs installers togle-release.pub <stable-folder>
   ```

4. Run the published command on each target system with a fresh user profile. For a download and signature check without installing, set `TOGLE_INSTALL_DRY_RUN=1` before running the installer.

   ```cmd
   set "TOGLE_INSTALL_DRY_RUN=1"
   powershell -NoProfile -Command "iex (irm https://togle.app/stable/install.ps1 -ErrorAction Stop)"
   set "TOGLE_INSTALL_DRY_RUN="
   ```

   ```sh
   curl -fsSL https://togle.app/beta/install.sh | TOGLE_INSTALL_DRY_RUN=1 sh
   ```

## What runs where

| | Install | Update |
| --- | --- | --- |
| Windows Command Prompt | `powershell -NoProfile -Command "iex (irm https://togle.app/stable/install.ps1 -ErrorAction Stop)"` checks the installer with PowerShell's own RSA, then runs it quietly for the current user. | Togle checks the installer, then runs it quietly once it has quit; it opens again |
| Mac | `curl -fsSL https://togle.app/stable/install.sh \| sh` verifies the ZIP and runs Apple's Gatekeeper check before installing to `~/Applications`. | Togle checks the ZIP and opens its location. |
| Linux | The same command verifies the x64 AppImage and adds Togle to the user's applications menu. | Togle checks the AppImage, replaces itself and starts again. |

`--connector` (Togle for a server) is not released yet: it comes with Togle Studio's devices.

## winget and Homebrew

`winget install togle` and `brew install togle` need Togle listed there: a manifest in microsoft/winget-pkgs (the
installer's address and its SHA-256) and a cask in Homebrew. Both point at the signed files of the GitHub release.
The installers also need Windows code signing (Authenticode) and Apple's Developer ID with notarization, which take
the maintainer's own certificates.

Signatures are RSA-3072 with SHA-256 (PKCS #1 v1.5), which Windows PowerShell 5.1, openssl and Node all check without
anything to install. `npm test` runs both install scripts against a stand-in release (`test/install-scripts.test.mjs`).
