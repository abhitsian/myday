#!/bin/zsh
# Fetches the official Node runtime that gets bundled into My Day.app.
#
# The official build is used rather than a Homebrew one because Homebrew's node links
# fifteen dylibs from /opt/homebrew, all of which would have to be copied and relocated.
# The nodejs.org build links nothing outside the OS.
set -e
cd "$(dirname "$0")/.."
V=${1:-v22.14.0}
ARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
TARBALL="node-$V-darwin-$ARCH.tar.gz"
mkdir -p vendor && cd vendor
echo "▸ fetching $TARBALL"
curl -fL --progress-bar -o "$TARBALL" "https://nodejs.org/dist/$V/$TARBALL"
tar xzf "$TARBALL" "node-$V-darwin-$ARCH/bin/node"
mv "node-$V-darwin-$ARCH/bin/node" node
rm -rf "node-$V-darwin-$ARCH" "$TARBALL"
chmod +x node
echo "▸ vendor/node ready — $(./node --version)"
