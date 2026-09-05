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

# The kit's Node package, as a tarball the wizard can install into a customer's
# agent without network access to a registry (zero-code guard wiring).
( cd "$ROOT/packages/typescript" && npm run build --silent >/dev/null 2>&1 && npm pack --silent --pack-destination "$OUT" >/dev/null )
KIT_TGZ="$(ls "$OUT"/zaatarlabs-agent365-governance-kit-*.tgz | head -1)"

stage() {                    # $1 = staging dir
  mkdir -p "$1/kit/installer" "$1/kit/wizard/lib" "$1/kit/packages"
  cp "$KIT_TGZ"                                                    "$1/kit/packages/"
  cp "$ROOT/installer/server.mjs" "$ROOT/installer/ui.html"        "$1/kit/installer/"
  cp "$ROOT/wizard/agent365-govern.mjs"                            "$1/kit/wizard/"
  cp "$ROOT/wizard/lib/agent365.mjs" "$ROOT/wizard/lib/capabilities.mjs" \
     "$ROOT/wizard/lib/auth.mjs" "$ROOT/wizard/lib/teams.mjs"              "$1/kit/wizard/lib/"
  cp "$ROOT/installer/README.md"                                   "$1/README.txt"
}

# ---------- macOS ----------
MACTMP="$(mktemp -d)"
MAC="$MACTMP/Agent365-Setup"        # named, so the zip doesn't carry a temp name
mkdir -p "$MAC"
cp -R "$ROOT/installer/macos/Agent 365 Setup.app" "$MAC/"
APP="$MAC/Agent 365 Setup.app"
# The kit goes INSIDE the bundle: macOS runs a downloaded app from a translocated
# copy, so files beside the app are not visible to it. Self-contained is the only
# layout that survives that. The README sits next to the app for humans.
stage "$APP/Contents/Resources"
mv "$APP/Contents/Resources/README.txt" "$MAC/README.txt"
# The executable is a small universal binary (Apple notarises real code, not a
# bare script bundle); it hands over to launch.sh. Rebuild it from source so the
# zip never ships a stale binary.
clang -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -o "$APP/Contents/MacOS/launch" "$ROOT/installer/macos/launcher.c"
chmod +x "$APP/Contents/MacOS/launch" "$APP/Contents/Resources/launch.sh"

# Sign + notarise when a Developer ID identity and a notarytool keychain
# profile ("AC_PASSWORD") exist on this Mac; otherwise ship unsigned and say so.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"' || true)"
if [ -n "$IDENTITY" ]; then
  echo "Signing with: $IDENTITY"
  codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  if xcrun notarytool history --keychain-profile AC_PASSWORD >/dev/null 2>&1; then
    NOTZIP="$MACTMP/notarize.zip"
    ditto -c -k --keepParent "$APP" "$NOTZIP"
    echo "Submitting to Apple notary service (usually 1-5 minutes)…"
    xcrun notarytool submit "$NOTZIP" --keychain-profile AC_PASSWORD --wait
    xcrun stapler staple "$APP"
    spctl --assess --type execute --verbose=2 "$APP" || true
  else
    echo "WARNING: no notarytool keychain profile AC_PASSWORD — signed but NOT notarised (Gatekeeper will still block)." >&2
  fi
else
  echo "WARNING: no 'Developer ID Application' identity — macOS app is UNSIGNED; customers must use Open Anyway." >&2
fi
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
