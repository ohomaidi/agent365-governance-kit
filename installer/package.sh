#!/usr/bin/env bash
# Build the two files you hand a customer.
#
# Each zip is self-contained: launcher at the top, and the only kit files the
# installer actually needs underneath. The wizard and installer use nothing but
# Node built-ins, so there are no dependencies to install on the far side.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist-installer"
rm -rf "$OUT"; mkdir -p "$OUT"

stage() {                    # $1 = staging dir
  mkdir -p "$1/kit/installer" "$1/kit/wizard/lib"
  cp "$ROOT/installer/server.mjs" "$ROOT/installer/ui.html"        "$1/kit/installer/"
  cp "$ROOT/wizard/agent365-govern.mjs"                            "$1/kit/wizard/"
  cp "$ROOT/wizard/lib/agent365.mjs" "$ROOT/wizard/lib/capabilities.mjs" "$1/kit/wizard/lib/"
  cp "$ROOT/installer/README.md"                                   "$1/README.txt"
}

# ---------- macOS ----------
MACTMP="$(mktemp -d)"
MAC="$MACTMP/Agent365-Setup"        # named, so the zip doesn't carry a temp name
mkdir -p "$MAC"
stage "$MAC"
cp -R "$ROOT/installer/macos/Agent 365 Setup.app" "$MAC/"
chmod +x "$MAC/Agent 365 Setup.app/Contents/MacOS/launch"
# ditto preserves the bundle and the executable bit; plain zip can drop it.
# --norsrc/--noextattr keep the __MACOSX sidecar files out of the archive.
( cd "$MACTMP" && ditto -c -k --norsrc --noextattr "Agent365-Setup" "$OUT/Agent365-Setup-macOS.zip" )
rm -rf "$MACTMP"

# ---------- Windows ----------
WINTMP="$(mktemp -d)"
WIN="$WINTMP/Agent365-Setup"
mkdir -p "$WIN"
stage "$WIN"
cp "$ROOT/installer/windows/Agent 365 Setup.vbs" "$WIN/"
( cd "$WINTMP" && zip -qr -X "$OUT/Agent365-Setup-Windows.zip" "Agent365-Setup" )
rm -rf "$WINTMP"

echo "Built:"
for f in "$OUT"/*.zip; do printf "  %-38s %s\n" "$(basename "$f")" "$(du -h "$f" | cut -f1)"; done
