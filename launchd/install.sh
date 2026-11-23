#!/bin/bash
# Renders launchd/com.zy.assistant.plist.template into
# ~/Library/LaunchAgents/com.zy.assistant.plist and prepares the directories.
# It loads nothing: the launchctl commands are printed, to be run by hand.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HOME:?HOME is not set}
label=com.zy.assistant
target="$home/Library/LaunchAgents/$label.plist"

mkdir -p "$home/Library/LaunchAgents" "$home/Library/Logs" "$home/Library/Application Support/zy-assistant"

sed -e "s|__REPO__|$repo|g" -e "s|__HOME__|$home|g" "$repo/launchd/$label.plist.template" > "$target"
plutil -lint "$target" > /dev/null

echo "rendered $target"
echo "the tokens stay outside the plist: put them in ~/.config/zy-assistant/env first."
echo "then:"
echo "  launchctl bootstrap gui/$(id -u) \"$target\""
echo "  launchctl bootout gui/$(id -u)/$label"
echo "  tail -n 50 \"$home/Library/Logs/zy-assistant.log\""
