#!/bin/zsh
# Builds My Day.dmg — the drag-to-Applications installer.
#
# The app is signed ad-hoc, not with an Apple Developer ID, so macOS quarantines it on
# download and refuses the first double-click. Right-click and Open clears that once, and
# the README says so plainly rather than letting someone hit a scary dialog unprepared.
set -e
cd "$(dirname "$0")/.."
APP="app/build/My Day.app"
[ -d "$APP" ] || { echo "build the app first: ./app/build-app.sh"; exit 1; }

OUT="app/build/My Day.dmg"
STAGE=$(mktemp -d)/MyDay
mkdir -p "$STAGE"

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"        # the drag target

# A short note beside the icons, because the first launch needs one extra click.
cat > "$STAGE/Read me first.txt" <<'NOTE'
My Day

1. Drag My Day into the Applications folder beside it.
2. The first time you open it, RIGHT-CLICK the app and choose Open,
   then click Open again in the dialog.

That second step is needed once. My Day is signed ad-hoc rather than with a
paid Apple Developer certificate, so macOS asks you to confirm the first launch.
Every launch after that is a normal double-click.

Nothing is uploaded. Everything it records is plain Markdown in ~/.myday/
and "Uninstall" in the menu bar removes all of it.

https://github.com/abhitsian/myday
NOTE

rm -f "$OUT"
hdiutil create -volname "My Day" -srcfolder "$STAGE" -ov -format ULFO "$OUT" >/dev/null
rm -rf "$(dirname "$STAGE")"

echo "Built: $OUT  ($(du -sh "$OUT" | cut -f1))"
