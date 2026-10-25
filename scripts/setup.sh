#!/bin/bash
# One-time setup: Python environment for the fundamentals refresh (screener.in / stockanalysis.com).
set -e
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet "requests>=2.31" "beautifulsoup4>=4.12"
echo "Python environment ready."
echo "Optional free local AI model:  brew install ollama && brew services start ollama && ollama pull qwen2.5:7b"

# Login services (engine always on, local AI): fill in this folder's path and load them
mkdir -p "$HOME/Library/LaunchAgents" data/logs
for s in engine ollama; do
  sed "s#__KUBER_DIR__#$(pwd)#g" "scripts/launchd/com.kuber.$s.plist" > "$HOME/Library/LaunchAgents/com.kuber.$s.plist"
done
echo "Login services written to ~/Library/LaunchAgents (load: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kuber.engine.plist)"
