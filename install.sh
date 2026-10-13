#!/bin/sh
# NightCrew installer: downloads the nightcrew binary for this machine.
#   curl -fsSL https://raw.githubusercontent.com/oluoyefeso/nightcrew/main/install.sh | sh
set -eu

REPO="oluoyefeso/nightcrew"
RELEASE_TAG="${NIGHTCREW_VERSION:-v1.0.0-alpha.12}"
DEST="${NIGHTCREW_INSTALL_DIR:-$HOME/.nightcrew/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
  darwin|linux) ;;
  *) echo "NightCrew runs on macOS and Linux. This machine reports $os." >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported CPU: $arch." >&2; exit 1 ;;
esac

asset="nightcrew-$os-$arch"
url="https://github.com/$REPO/releases/download/$RELEASE_TAG/$asset"
echo "Downloading ${asset}…"
mkdir -p "$DEST"
tmp=$(mktemp)
if ! curl -fSL --progress-bar "$url" -o "$tmp"; then
  echo "Couldn't download $url. Check https://github.com/$REPO/releases." >&2
  rm -f "$tmp"
  exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$DEST/nightcrew"
echo "Installed to $DEST/nightcrew"

missing=""
for cmd in git gh claude; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
  echo
  echo "NightCrew also needs:$missing"
  echo "  git     https://git-scm.com"
  echo "  gh      https://cli.github.com (then: gh auth login)"
  echo "  claude  https://claude.com/claude-code (or set ANTHROPIC_API_KEY)"
fi

case ":$PATH:" in
  *":$DEST:"*) ;;
  *)
    echo
    echo "Add NightCrew to your PATH:"
    echo "  echo 'export PATH=\"$DEST:\$PATH\"' >> ~/.$(basename "${SHELL:-sh}")rc"
    ;;
esac

echo
echo "Next: cd into a repo, then run"
echo "  nightcrew repo add"
echo "  nightcrew"
