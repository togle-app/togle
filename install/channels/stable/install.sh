#!/bin/sh
# Installs Togle Free for the current user after checking the download against Togle's release key.
# Beta:   curl -fsSL https://togle.app/beta/install.sh | sh
# Stable: curl -fsSL https://togle.app/stable/install.sh | sh
set -eu

RELEASE_SOURCE='https://api.github.com/repos/togle-app/togle/releases/latest'
RELEASES="${TOGLE_INSTALL_RELEASES:-$RELEASE_SOURCE}"
PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAjrG3LNas8oqsyscSaTyo
+lpkYkk8DId4RwTZ47fcFs8Cv9FeJKUxhG0+FWjX3Ajn9aYs2SNo8gh5J5M4OmdZ
NRK3Qk4ua93IvUIzWm70Uq7BD7JGP/fgQrdK4WHBsymwW9ClNJBHbv44H0RWURBo
JthGjHNYRn6s4tdTbTrWPjWcXBx1XBe7HvjJqsoihWGdS+00ORCXmKf6VO6uTwIR
I2lz4m/1vBEa7xEb7rqF4tmOUM/G3oNMpWyOZdRWuecwfMiNcgPGDmmlGmWX8BsX
KfMC6VFEjyC0pky0ViCRdeucT6fQQg7C0UbSuVpWj5mDk/zS0y+Q39NkUk/Emvtf
nBu6iMOtLTZravT6jgTnLNIgUJsWo0Owbyav7Ewu2yd7u0BVFl0glN/bI9RcV5dC
6xwL5IURkxyv1LlfHpyfiAtIL0C+z9OYaQMtERwSv1JDX//uHY0ypFRGlONATmOk
0mF7SUEMwElcTw8uIIyS6p75ofyU+teCqkaR1Dr0+YyTAgMBAAE=
-----END PUBLIC KEY-----'

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --connector) die "The connector, Togle for a server, is not released yet. It comes with Togle Studio's devices." ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
case "$PUBLIC_KEY" in
  __*) die "This install script has no release key written in. Get it from https://togle.app/beta/install.sh." ;;
esac

platform=${TOGLE_INSTALL_PLATFORM:-}
if [ -z "$platform" ]; then
  os=$(uname -s)
  arch=$(uname -m)
  if [ "$os" = Darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  platform="$os-$arch"
fi
case "$platform" in
  Darwin-arm64|darwin-arm64) suffixes='-arm64-mac.zip' ;;
  Darwin-x86_64|darwin-x64) suffixes='-x64-mac.zip -mac.zip' ;;
  Linux-x86_64|linux-x64) suffixes='-x64.AppImage .AppImage' ;;
  *) die "Togle Free has no build for $platform yet." ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || die "Togle's installer needs $1."; }
need curl
need openssl

fetch() {
  curl -q -sSL --retry 3 --retry-all-errors --retry-max-time 60 --connect-timeout 15 \
    -H 'User-Agent: togle-install' "$@"
}

work=$(mktemp -d)
stage=''
lock=''
backup=''
cleanup() {
  if [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$app" ]; then
    mv "$backup" "$app" || {
      printf 'Your previous Togle app is at %s.\n' "$backup" >&2
      stage=''
    }
  fi
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  if [ -n "$lock" ]; then rmdir "$lock"; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

status=$(fetch --write-out '%{http_code}' --output "$work/release.json" "$RELEASES") || die "Couldn't reach GitHub Releases. Try again in a moment."
if [ "${RELEASE_SOURCE##*/}" = latest ]; then
  if [ "$status" = 404 ] || grep -Eq '"prerelease"[[:space:]]*:[[:space:]]*true' "$work/release.json"; then
    die 'No stable release of Togle Free is available yet. The beta command is at https://togle.app/beta/install.sh.'
  fi
fi
if [ "$status" != 200 ]; then die "Couldn't find the Togle Free release on GitHub (HTTP $status)."; fi

# Match the packaged filenames for this release and require an attached signature.
tag=$(grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' "$work/release.json" | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\1/' | head -n 1)
version=${tag#v}
case "$version" in
  ''|*[!a-zA-Z0-9.+-]*) die "Couldn't read the Togle Free release version from GitHub." ;;
esac
assets=$(grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"https?://[^"]+"' "$work/release.json" \
  | sed -E 's/^[^:]+:[[:space:]]*"([^"]+)"$/\1/')
url=''
for suffix in $suffixes; do
  name="Togle-$version$suffix"
  candidate=$(printf '%s\n' "$assets" | awk -F / -v name="$name" '$NF == name { print; exit }')
  if [ -n "$candidate" ] && printf '%s\n' "$assets" | grep -Fqx -e "$candidate.sig"; then
    url=$candidate
    break
  fi
done
if [ -z "$url" ]; then die "Togle Free $tag has no build for $platform with a release signature."; fi
name=${url##*/}

echo "Downloading $name..."
fetch --fail --output "$work/$name" "$url" || die "Couldn't download $name. Try again in a moment."
fetch --fail --output "$work/$name.sig" "$url.sig" || die "Couldn't download the release signature. Try again in a moment."
printf '%s\n' "$PUBLIC_KEY" > "$work/release.pub"
# RSA-3072, SHA-256, PKCS #1 v1.5: the signature release-key.mjs makes.
if ! openssl dgst -sha256 -verify "$work/release.pub" -signature "$work/$name.sig" "$work/$name" >/dev/null 2>&1; then
  die "The download does not match Togle's release key, so nothing was installed."
fi
echo "Signature checked."
if [ "${TOGLE_INSTALL_DRY_RUN:-0}" = 1 ]; then echo "Checked, not installed: $name"; exit 0; fi

case "$platform" in
  Darwin*|darwin*)
    need ditto
    need syspolicy_check
    applications="$HOME/Applications"
    app="$applications/Togle.app"
    mkdir -p "$applications"
    if ! mkdir "$applications/.togle-install-lock" 2>/dev/null; then
      die 'Another Togle Free installation is in progress in ~/Applications.'
    fi
    lock="$applications/.togle-install-lock"
    stage=$(mktemp -d "$applications/.togle-install.XXXXXX")
    ditto -x -k "$work/$name" "$stage"
    if [ ! -d "$stage/Togle.app" ] || ! syspolicy_check distribution "$stage/Togle.app"; then
      die "macOS could not verify the Togle Free app. Your previous installation is still available if you had one."
    fi
    if pgrep -u "$(id -u)" -x Togle >/dev/null 2>&1; then
      die 'Quit Togle and run the install command again.'
    fi
    if [ -e "$app" ] || [ -L "$app" ]; then
      backup="$stage/previous.app"
      mv "$app" "$backup"
    fi
    mv "$stage/Togle.app" "$app"
    echo 'Togle Free is installed in ~/Applications. Open Togle from Finder.'
    ;;
  *)
    data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
    case "$data_home" in /*) ;; *) data_home="$HOME/.local/share" ;; esac
    dir="$data_home/togle"
    mkdir -p "$dir" "$data_home/applications"
    stage=$(mktemp -d "$data_home/.togle-install.XXXXXX")
    cp "$work/$name" "$stage/Togle.AppImage"
    cat > "$stage/togle" <<'LAUNCHER'
#!/bin/sh
if [ ! -r /dev/fuse ] || [ ! -w /dev/fuse ] || ! ldconfig -p 2>/dev/null | grep -Fq 'libfuse.so.2'; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
exec "$(dirname "$0")/Togle.AppImage" "$@"
LAUNCHER
    chmod 755 "$stage/Togle.AppImage" "$stage/togle"
    # Desktop Entry quoting escapes special characters twice inside a quoted Exec argument.
    executable=$(printf '%s' "$dir/togle" | sed 's/\\/\\\\\\\\/g; s/["$`]/\\\\&/g; s/%/%%/g')
    printf '[Desktop Entry]\nType=Application\nName=Togle\nExec="%s"\nTerminal=false\nCategories=Office;\n' "$executable" > "$stage/togle.desktop"
    mv -f "$stage/Togle.AppImage" "$stage/togle" "$dir/"
    mv -f "$stage/togle.desktop" "$data_home/applications/togle.desktop"
    echo 'Togle Free is installed. Open Togle from your applications menu.'
    ;;
esac
