#!/bin/bash
# Double-click to stop KUBER's background engine and local AI until the next login (or until you open KUBER again).
U="gui/$(id -u)"
launchctl bootout "$U/com.kuber.engine" 2>/dev/null && echo "KUBER engine stopped." || echo "KUBER engine was not running."
launchctl bootout "$U/com.kuber.ollama" 2>/dev/null && echo "KUBER local AI stopped."
