#!/bin/zsh
# Builds My Day.app — a self-contained bundle with the Node package inside it.
#
# The app holds the Accessibility grant itself, which is the reason it exists: a separate
# helper binary meant asking people to find a file inside node_modules in a file picker,
# and the grant died on every package update. An app bundle can ask for the permission with
# macOS's own dialog and keeps it across updates.
#
#   ./app/build-app.sh              build into app/build/My Day.app
#   ./app/build-app.sh --install    …and move it to /Applications
#
# Rebuilding changes the signature, which invalidates any existing Accessibility grant.
# macOS keeps the old entry listed but stops honouring it, so remove and re-add after a
# rebuild. The script says so at the end.
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="$ROOT/app/build/My Day.app"
C="$APP/Contents"

rm -rf "$APP"
mkdir -p "$C/MacOS" "$C/Resources"

echo "▸ compiling"
swiftc -O -parse-as-library \
  -target arm64-apple-macosx13.0 \
  -framework Cocoa -framework SwiftUI -framework WebKit -framework ApplicationServices -framework ServiceManagement \
  -o "$C/MacOS/MyDay" \
  "$ROOT/app/Sources/Core.swift" \
  "$ROOT/app/Sources/Onboarding.swift" \
  "$ROOT/app/Sources/App.swift"

echo "▸ bundling the Node package"
# Everything the CLI and MCP server need, minus the app sources and any local state.
mkdir -p "$C/Resources/node"
for d in bin lib mcp public package.json README.md THREAT-MODEL.md LICENSE; do
  cp -R "$ROOT/$d" "$C/Resources/node/" 2>/dev/null || true
done

cp "$ROOT/app/Info.plist" "$C/Info.plist"
[ -f "$ROOT/app/AppIcon.icns" ] && cp "$ROOT/app/AppIcon.icns" "$C/Resources/AppIcon.icns"

echo "▸ signing (ad-hoc — no Developer ID on this machine)"
codesign --force --deep --sign - --identifier com.abhitsian.myday "$APP"

if [[ "$1" == "--install" ]]; then
  echo "▸ installing to /Applications"
  rm -rf "/Applications/My Day.app"
  cp -R "$APP" /Applications/
  APP="/Applications/My Day.app"
fi

echo
echo "Built: $APP"
echo "  size: $(du -sh "$APP" | cut -f1)"
echo
echo "If you had already granted Accessibility, this rebuild invalidated it."
echo "Remove and re-add “My Day” in System Settings → Privacy & Security → Accessibility."
