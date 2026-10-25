#!/bin/bash
# Opens the KUBER window. The engine and the local AI run as login services (launchd), so they keep
# recording whether or not this window is open; this script only (re)starts them if they aren't loaded.
KUBER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:8777"; U="gui/$(id -u)"
for s in engine ollama; do
  launchctl print "$U/com.kuber.$s" >/dev/null 2>&1 || launchctl bootstrap "$U" "$HOME/Library/LaunchAgents/com.kuber.$s.plist" 2>/dev/null
done
for i in $(seq 1 40); do curl -s -o /dev/null "$URL/login" && break; sleep 0.5; done
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --user-data-dir="$HOME/Library/Application Support/KUBER/window" --window-size=1440,960 --no-first-run --no-default-browser-check
else open "$URL"; fi
