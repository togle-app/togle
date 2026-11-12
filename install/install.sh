#!/bin/sh
# Installs Togle on a Mac or Linux for the person who runs it, with no administrator rights: the latest release from
# GitHub, checked against Togle's release key before it is installed. The key is written in when the script is
# published; it is the same key every update is checked with.
#   curl -fsSL https://togle.app/install.sh | sh
#   curl -fsSL https://togle.app/install.sh | sh -s -- --connector     (a server: only the connector)
set -eu

RELEASES="${TOGLE_INSTALL_RELEASES:-https://api.github.com/repos/togle-app/togle/releases/latest}"
PUBLIC_KEY='__TOGLE_RELEASE_PUBLIC_KEY__'

connector=0
for arg in "$@"; do
  case "$arg" in
    --connector) connector=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [ "$connector" = 1 ]; then
  echo "The connector, Togle for a server, is not released yet. It comes with Togle Studio's devices." >&2
  exit 1
fi
case "$PUBLIC_KEY" in
  __*) echo "This install script has no release key written in. Get it from https://togle.app/install.sh" >&2; exit 1 ;;
esac

platform="${TOGLE_INSTALL_PLATFORM:-$(uname -s)-$(uname -m)}"
exclude='^$'
case "$platform" in
  Darwin-arm64|darwin-arm64) pattern='-arm64-mac\.zip$' ;;
  Darwin-x86_64|darwin-x64) pattern='-mac\.zip$'; exclude='arm64' ;;
  Linux-x86_64|linux-x64) pattern='\.AppImage$' ;;
  *) echo "Togle has no build for $platform yet." >&2; exit 1 ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "Togle's installer needs $1." >&2; exit 1; }; }
need curl
need openssl

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
curl -fsSL -H 'User-Agent: togle-install' "$RELEASES" -o "$work/release.json"
# Each asset's address, read without jq.
url=$(grep -o '"browser_download_url": *"[^"]*"' "$work/release.json" | sed 's/.*"\(http[^"]*\)"$/\1/' \
  | grep -E -e "$pattern" | grep -v -E -e "$exclude" | grep -v -e '\.sig$' | head -n 1 || true)
if [ -z "$url" ]; then echo "The latest release of Togle has no build for $platform." >&2; exit 1; fi
name=${url##*/}

echo "Downloading $name..."
curl -fsSL -H 'User-Agent: togle-install' "$url" -o "$work/$name"
curl -fsSL -H 'User-Agent: togle-install' "$url.sig" -o "$work/$name.sig"
printf '%s\n' "$PUBLIC_KEY" > "$work/release.pub"
# RSA-3072, SHA-256, PKCS #1 v1.5: the signature release-key.mjs makes.
if ! openssl dgst -sha256 -verify "$work/release.pub" -signature "$work/$name.sig" "$work/$name" >/dev/null 2>&1; then
  echo "The download does not match Togle's release key, so nothing was installed." >&2
  exit 1
fi
echo "Signature checked."
if [ "${TOGLE_INSTALL_DRY_RUN:-0}" = 1 ]; then echo "Checked, not installed: $name"; exit 0; fi

case "$platform" in
  Darwin*|darwin*)
    mkdir -p "$HOME/Applications"
    rm -rf "$HOME/Applications/Togle.app"
    ditto -x -k "$work/$name" "$HOME/Applications"
    echo "Togle is in ~/Applications. Open it, then hold F9 (with Fn on most keyboards) and talk."
    ;;
  *)
    dir="$HOME/.local/share/togle"
    mkdir -p "$dir" "$HOME/.local/share/applications"
    cp "$work/$name" "$dir/Togle.AppImage.new"
    chmod 755 "$dir/Togle.AppImage.new"
    mv -f "$dir/Togle.AppImage.new" "$dir/Togle.AppImage"
    printf '[Desktop Entry]\nType=Application\nName=Togle\nComment=Your voice, your meetings and your agents\nExec="%s" %%U\nTerminal=false\nCategories=Office;\n' "$dir/Togle.AppImage" \
      > "$HOME/.local/share/applications/togle.desktop"
    echo "Togle is installed. Open it from your apps, then press F9 and talk."
    ;;
esac
