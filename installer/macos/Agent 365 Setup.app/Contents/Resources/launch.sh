#!/bin/bash
# Agent 365 Governance Kit — macOS launcher.
# Double-clicked by the customer. Finds Node (or downloads a private copy),
# starts the local setup server, and opens the browser. LSUIElement keeps it
# out of the Dock and off the screen.
set -u

NODE_VERSION="22.12.0"
APP_HOME="$HOME/.agent365"

dialog() { osascript -e "display dialog \"$1\" with title \"Agent 365 Setup\" buttons {\"$2\",\"$3\"} default button \"$3\"" 2>/dev/null; }
alert()  { osascript -e "display alert \"Agent 365 Setup\" message \"$1\" as critical" >/dev/null 2>&1; }
notice() { osascript -e "display notification \"$1\" with title \"Agent 365 Setup\"" >/dev/null 2>&1; }

# Find the kit rather than assuming a fixed depth: this app is shipped both
# inside the repo (installer/macos/...) and at the top of a distribution zip
# next to a "kit" folder.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER=""
# Shipped form: the kit lives INSIDE the bundle (Contents/Resources/kit), so a
# downloaded app still works when macOS runs it from a translocated copy.
if [ -f "$HERE/kit/installer/server.mjs" ]; then SERVER="$HERE/kit/installer/server.mjs"; fi
CANDIDATE="$HERE"
for _ in 1 2 3 4 5 6; do
  [ -n "$SERVER" ] && break
  CANDIDATE="$(cd "$CANDIDATE/.." 2>/dev/null && pwd)" || break
  if [ -f "$CANDIDATE/installer/server.mjs" ]; then SERVER="$CANDIDATE/installer/server.mjs"; break; fi
  if [ -f "$CANDIDATE/kit/installer/server.mjs" ]; then SERVER="$CANDIDATE/kit/installer/server.mjs"; break; fi
done

if [ -z "$SERVER" ] || [ ! -f "$SERVER" ]; then
  alert "Could not find the setup files inside the app. Re-download Agent365-Setup-macOS.zip."
  exit 1
fi

# Homebrew and nvm aren't on a GUI app's PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$APP_HOME/node-v$NODE_VERSION/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ]
}

# No Node (or too old): fetch the official build into the user's folder.
# Nothing system-wide changes and no admin password is asked for.
if ! node_ok; then
  if ! dialog "Node.js is needed to run the setup page.\n\nDownload a private copy (about 50 MB) into your user folder? Nothing else on this Mac is changed." "Cancel" "Download" | grep -q Download; then
    exit 1
  fi
  ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] || ARCH="x64"
  TARBALL="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
  mkdir -p "$APP_HOME"
  notice "Downloading Node.js $NODE_VERSION…"
  if ! curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$APP_HOME/$TARBALL"; then
    alert "The download failed. Check the internet connection and try again."
    exit 1
  fi
  rm -rf "$APP_HOME/node-v$NODE_VERSION"
  mkdir -p "$APP_HOME/node-v$NODE_VERSION"
  tar -xzf "$APP_HOME/$TARBALL" -C "$APP_HOME/node-v$NODE_VERSION" --strip-components=1
  rm -f "$APP_HOME/$TARBALL"
  export PATH="$APP_HOME/node-v$NODE_VERSION/bin:$PATH"
  if ! node_ok; then
    alert "Node.js was downloaded but did not start. Install it from nodejs.org and try again."
    exit 1
  fi
fi

exec node "$SERVER"
