#!/bin/bash
set -euo pipefail

NODE_VERSION="22.23.2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nParadigmEve Mac build stopped: %s\n' "$*" >&2
  exit 1
}

if [ "$HOST_OS" != "Darwin" ]; then
  die "this USB entrypoint builds the native macOS package and must run on macOS (detected $HOST_OS)."
fi

case "$HOST_ARCH" in
  arm64) PACKAGE_ARCH="arm64" ;;
  x86_64) PACKAGE_ARCH="x64" ;;
  *) die "unsupported Mac architecture: $HOST_ARCH" ;;
esac

say "Checking Apple's native build tools"
if ! command -v xcrun >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1 || ! xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1; then
  printf '%s\n' \
    "Apple Command Line Tools/Xcode are required for the Swift Desktop backend." \
    "macOS may ask for an administrator password once while Apple installs them." \
    "After the Apple installer finishes, run BUILD-MAC.command again."
  xcode-select --install >/dev/null 2>&1 || true
  exit 2
fi

TOOLCHAIN_ROOT="$HOME/Library/Caches/ParadigmEve/toolchain"
NODE_BASENAME="node-v${NODE_VERSION}-darwin-${PACKAGE_ARCH}"
NODE_ARCHIVE="${NODE_BASENAME}.tar.gz"
NODE_DIR="$TOOLCHAIN_ROOT/$NODE_BASENAME"
DOWNLOAD_DIR="$TOOLCHAIN_ROOT/downloads"
mkdir -p "$TOOLCHAIN_ROOT" "$DOWNLOAD_DIR"

node22_available() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(`.`)[0]' 2>/dev/null || true)" = "22" ]
}

if node22_available; then
  say "Using existing Node $(node --version) at $(command -v node)"
else
  say "Preparing user-local Node v${NODE_VERSION} for ${PACKAGE_ARCH}"
  CACHED_ARCHIVE="$REPO_ROOT/redist/macos/$NODE_ARCHIVE"
  if [ ! -f "$CACHED_ARCHIVE" ]; then
    CACHED_ARCHIVE="$REPO_ROOT/redist/$NODE_ARCHIVE"
  fi
  if [ -f "$CACHED_ARCHIVE" ]; then
    ARCHIVE="$CACHED_ARCHIVE"
    printf 'Using USB cache: %s\n' "$ARCHIVE"
  else
    ARCHIVE="$DOWNLOAD_DIR/$NODE_ARCHIVE"
    if [ ! -f "$ARCHIVE" ]; then
      command -v curl >/dev/null 2>&1 || die "curl is unavailable and $NODE_ARCHIVE is not present under redist/."
      printf 'Downloading Node from nodejs.org because the USB cache does not contain %s\n' "$NODE_ARCHIVE"
      curl --fail --location --proto '=https' --tlsv1.2 \
        "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
        --output "$ARCHIVE"
    fi
  fi

  LOCAL_SUMS="$REPO_ROOT/redist/macos/SHASUMS256.txt"
  if [ ! -f "$LOCAL_SUMS" ]; then
    LOCAL_SUMS="$REPO_ROOT/redist/SHASUMS256.txt"
  fi
  if [ -f "$LOCAL_SUMS" ]; then
    SUMS="$LOCAL_SUMS"
  else
    SUMS="$DOWNLOAD_DIR/node-v${NODE_VERSION}-SHASUMS256.txt"
    if [ ! -f "$SUMS" ]; then
      command -v curl >/dev/null 2>&1 || die "cannot verify $NODE_ARCHIVE: curl is unavailable and no SHASUMS256.txt is cached."
      curl --fail --location --proto '=https' --tlsv1.2 \
        "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
        --output "$SUMS"
    fi
  fi

  EXPECTED="$(awk -v file="$NODE_ARCHIVE" '$2 == file { print $1; exit }' "$SUMS")"
  [ -n "$EXPECTED" ] || die "$NODE_ARCHIVE is not listed in $SUMS"
  ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
  [ "$ACTUAL" = "$EXPECTED" ] || die "Node archive checksum mismatch; expected $EXPECTED, got $ACTUAL"

  if [ ! -x "$NODE_DIR/bin/node" ]; then
    TMP_NODE_DIR="$TOOLCHAIN_ROOT/.${NODE_BASENAME}.tmp.$$"
    rm -rf "$TMP_NODE_DIR"
    mkdir -p "$TMP_NODE_DIR"
    tar -xzf "$ARCHIVE" -C "$TMP_NODE_DIR"
    [ -x "$TMP_NODE_DIR/$NODE_BASENAME/bin/node" ] || die "Node archive did not contain the expected executable"
    rm -rf "$NODE_DIR"
    mv "$TMP_NODE_DIR/$NODE_BASENAME" "$NODE_DIR"
    rmdir "$TMP_NODE_DIR"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
  node22_available || die "the user-local Node 22 toolchain did not start correctly"
  printf 'Using user-local %s at %s\n' "$(node --version)" "$(command -v node)"
fi

command -v git >/dev/null 2>&1 || die "git is unavailable. Apple Command Line Tools should provide it; finish their installation and retry."

if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]; then
  die "the USB repository has tracked uncommitted changes. Commit them first so the Mac build has an exact rollback identity."
fi

COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"
SHORT_COMMIT="$(printf '%s' "$COMMIT" | cut -c1-12)"
BUILD_ROOT="$HOME/Library/Caches/ParadigmEve/usb-build"
WORK_DIR="$BUILD_ROOT/${SHORT_COMMIT}-${PACKAGE_ARCH}"
mkdir -p "$BUILD_ROOT"

say "Copying exact commit $SHORT_COMMIT from USB to the Mac's local filesystem"
rm -rf "$WORK_DIR"
git clone --quiet --no-hardlinks "$REPO_ROOT" "$WORK_DIR"
git -C "$WORK_DIR" checkout --quiet --detach "$COMMIT"

cd "$WORK_DIR"
say "Installing JavaScript dependencies with Node $(node --version)"
npm ci

say "Running private Mac build verification"
npm run typecheck
npm run verify:notices
node -e "require('electron')"
npx vitest run \
  test/macos-adhoc-seal.test.ts \
  test/macos-desktop-hardening.test.ts \
  test/packaging.test.ts \
  test/platform.test.ts \
  test/setup-assistant.test.ts \
  test/renderer-state.test.ts

say "Building native ParadigmEve macOS ${PACKAGE_ARCH} package"
npm run "dist:mac:${PACKAGE_ARCH}"

say "Checking the packaged runtime and macOS bundle"
node scripts/smoke-packaged-runtime.mjs --platform darwin --arch "$PACKAGE_ARCH"
node scripts/smoke-macos-bundle.mjs "$PACKAGE_ARCH"
node scripts/smoke-macos-gui.mjs "$PACKAGE_ARCH"
hdiutil verify "release/ParadigmEve-macOS-${PACKAGE_ARCH}.dmg" >/dev/null
unzip -tq "release/ParadigmEve-macOS-${PACKAGE_ARCH}.zip"

OUTPUT_DIR="$REPO_ROOT/mac-build-output/${SHORT_COMMIT}-${PACKAGE_ARCH}"
mkdir -p "$OUTPUT_DIR"
cp "release/ParadigmEve-macOS-${PACKAGE_ARCH}.dmg" "$OUTPUT_DIR/"
cp "release/ParadigmEve-macOS-${PACKAGE_ARCH}.zip" "$OUTPUT_DIR/"
(
  cd "$OUTPUT_DIR"
  shasum -a 256 "ParadigmEve-macOS-${PACKAGE_ARCH}.dmg" "ParadigmEve-macOS-${PACKAGE_ARCH}.zip" > SHA256SUMS.txt
)

say "Build complete"
printf '%s\n' \
  "Commit: $COMMIT" \
  "Architecture: $PACKAGE_ARCH" \
  "Artifacts copied back to USB/repo:" \
  "  $OUTPUT_DIR" \
  "No system Node installation was changed."
