#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Shogo Worker installer.
# Mirrors Cursor's `curl https://cursor.com/install | bash` UX.
#
# Usage:
#   curl -fsSL https://install.shogo.ai | bash
#   curl -fsSL https://install.shogo.ai | bash -s -- --channel beta
#
# Flags:
#   --channel <stable|beta>   release channel (default: stable)
#   --prefix <dir>            install dir (default: $HOME/.shogo/bin)
#   --force                   overwrite existing install
#   --no-binary               force npm install even if a prebuilt binary exists

set -euo pipefail

CHANNEL="stable"
PREFIX="${HOME}/.shogo/bin"
FORCE=0
ALLOW_BINARY=1
RELEASE_HOST="${SHOGO_RELEASE_HOST:-https://releases.shogo.ai}"

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:?}"; shift 2 ;;
    --prefix)  PREFIX="${2:?}";  shift 2 ;;
    --force)   FORCE=1; shift ;;
    --no-binary) ALLOW_BINARY=0; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

info()  { printf "\033[34m•\033[0m %s\n" "$*"; }
ok()    { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m!\033[0m %s\n" "$*" >&2; }
die()   { printf "\033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }

verify_checksum() {
  local checksum_file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$checksum_file" >/dev/null
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$checksum_file" >/dev/null
  else
    warn "No SHA-256 checksum tool found; skipping verification"
    return 0
  fi
}

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) ARCH="$ARCH_RAW" ;;
esac

case "$OS" in
  darwin|linux) ;;
  *) die "Unsupported OS: $OS. Use install.ps1 on Windows." ;;
esac

TARGET="${OS}-${ARCH}"
info "Detected target: $TARGET (channel=$CHANNEL)"

BIN_PATH="$PREFIX/shogo"
if [ -x "$BIN_PATH" ] && [ "$FORCE" -eq 0 ]; then
  warn "shogo already installed at $BIN_PATH. Pass --force to reinstall."
  "$BIN_PATH" --version || true
  exit 0
fi

mkdir -p "$PREFIX"

install_binary() {
  local url="$RELEASE_HOST/cli/$CHANNEL/shogo-$TARGET.tar.gz"
  local sha_url="$url.sha256"
  local tmp; tmp="$(mktemp -d)"
  info "Downloading $url"
  if ! curl -fsSL "$url" -o "$tmp/shogo.tar.gz"; then
    return 1
  fi
  if curl -fsSL "$sha_url" -o "$tmp/shogo.sha256" 2>/dev/null; then
    info "Verifying checksum"
    ( cd "$tmp" && verify_checksum shogo.sha256 ) || die "Checksum mismatch"
  else
    warn "No checksum published yet; skipping verification"
  fi
  tar -xzf "$tmp/shogo.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/shogo" "$BIN_PATH"
  rm -rf "$tmp"
  ok "Installed binary to $BIN_PATH"
}

install_via_npm() {
  command -v npm >/dev/null 2>&1 || die "No prebuilt binary for $TARGET and npm not found. Install Node.js 20+ or use --force with a supported target."
  npm view @shogo-ai/worker version >/dev/null 2>&1 || die "@shogo-ai/worker is not published to npm or is not reachable. Install a prebuilt binary or try again after the package is published."
  local npm_prefix; npm_prefix="$(npm prefix -g 2>/dev/null)" || die "Unable to resolve npm global prefix"
  if [ -e "$npm_prefix" ] && [ ! -w "$npm_prefix" ]; then
    die "npm global prefix is not writable: $npm_prefix. Fix npm permissions or install a prebuilt binary."
  fi
  info "Installing via npm: @shogo-ai/worker"
  npm install -g @shogo-ai/worker
  ok "Installed via npm"
  BIN_PATH="$(command -v shogo || true)"
}

if [ "$ALLOW_BINARY" -eq 1 ] && install_binary; then
  :
else
  install_via_npm
fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    echo
    warn "$PREFIX is not in your PATH."
    echo "    Add this to ~/.zshrc or ~/.bashrc:"
    echo "      export PATH=\"$PREFIX:\$PATH\""
    ;;
esac

echo
"$BIN_PATH" --version 2>/dev/null && ok "shogo CLI ready"
echo
echo "Next steps:"
echo "  1. Create an API key:   https://studio.shogo.ai/api-keys"
echo "  2. Log in:              shogo login --api-key shogo_sk_..."
echo "  3. Start the worker:    shogo worker start --worker-dir ~/code/myrepo"
echo
echo "Docs: https://docs.shogo.ai/features/my-machines/quickstart"
