#!/bin/sh
# install.sh — install the `canarycode` (CanaryCode) CLI from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/CanaryCoders/CanaryCodeCli/main/install.sh | sh
#
# Downloads the prebuilt binary for your platform, verifies its sha256 against the
# release checksums, and installs it. No Bun or Node required.
#
# Environment:
#   CANARYCODE_VERSION       pin a release tag (e.g. v0.1.0). Defaults to the latest.
#   CANARYCODE_INSTALL_DIR   install directory. Defaults to ~/.local/bin.

set -eu

REPO="CanaryCoders/CanaryCodeCli"
INSTALL_DIR="${CANARYCODE_INSTALL_DIR:-$HOME/.local/bin}"

err() {
	echo "install: $1" >&2
	exit 1
}

# --- detect platform -------------------------------------------------------
os=$(uname -s)
case "$os" in
	Darwin) os="darwin" ;;
	Linux) os="linux" ;;
	*) err "unsupported OS: $os (only darwin and linux are released)" ;;
esac

arch=$(uname -m)
case "$arch" in
	arm64 | aarch64) arch="arm64" ;;
	x86_64 | amd64) arch="x64" ;;
	*) err "unsupported architecture: $arch" ;;
esac

asset="canarycode-${os}-${arch}"

# --- pick a downloader -----------------------------------------------------
if command -v curl >/dev/null 2>&1; then
	dl() { curl -fsSL "$1"; }
	dlo() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
	dl() { wget -qO- "$1"; }
	dlo() { wget -qO "$2" "$1"; }
else
	err "need curl or wget to download"
fi

# --- resolve the release tag ----------------------------------------------
tag="${CANARYCODE_VERSION:-}"
if [ -z "$tag" ]; then
	tag=$(dl "https://api.github.com/repos/$REPO/releases/latest" |
		grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
fi
[ -n "$tag" ] || err "could not resolve the latest release tag (set CANARYCODE_VERSION to pin one)"

base="https://github.com/$REPO/releases/download/$tag"
echo "install: canarycode $tag ($asset)"

# --- download binary + checksums ------------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dlo "$base/$asset" "$tmp/$asset" || err "failed to download $asset (does $tag have a $asset asset?)"
dlo "$base/checksums.txt" "$tmp/checksums.txt" || err "failed to download checksums.txt"

# --- verify checksum -------------------------------------------------------
expected=$(grep " $asset\$" "$tmp/checksums.txt" | head -n1 | awk '{print $1}')
[ -n "$expected" ] || err "checksums.txt has no entry for $asset"

if command -v sha256sum >/dev/null 2>&1; then
	actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
	actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
	err "need sha256sum or shasum to verify the download"
fi

[ "$actual" = "$expected" ] || err "checksum mismatch — refusing to install (expected $expected, got $actual)"

# --- install ---------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/canarycode"

echo "install: installed canarycode to $INSTALL_DIR/canarycode"

# --- PATH hint -------------------------------------------------------------
case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*)
		echo ""
		echo "  $INSTALL_DIR is not on your PATH. Add it, e.g.:"
		echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
		;;
esac

echo "Run 'canarycode --help' to get started."
