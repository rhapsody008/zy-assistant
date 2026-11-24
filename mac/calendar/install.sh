#!/usr/bin/env bash
# Renders the launchd job and the pusher's config. It loads nothing: the last two
# lines are printed for you to run, because starting an unattended job that reads
# your calendar is a decision, not an install step.
set -euo pipefail
cd "$(dirname "$0")"

APP="$(pwd)/zy-calendar-export.app/Contents/MacOS/zy-calendar-export"
LOG="$HOME/Library/Logs/zy-assistant-calendar.log"
AGENT="$HOME/Library/LaunchAgents/com.zy.assistant.calendar.plist"
CONFIG_DIR="$HOME/.config/zy-assistant"
CONFIG="$CONFIG_DIR/calendar.env"

[ -x "$APP" ] || { echo "build it first: ./build.sh" >&2; exit 1; }

echo "The kubeconfig the pusher uses (it already reaches the cluster's API)."
printf 'Path: '
read -r KUBECONFIG_PATH
[ -r "$KUBECONFIG_PATH" ] || { echo "cannot read $KUBECONFIG_PATH" >&2; exit 1; }

# launchd starts a job with a minimal PATH: record kubectl now, not later.
KUBECTL_PATH=$(command -v kubectl || true)
[ -n "$KUBECTL_PATH" ] || { echo "kubectl is not on PATH; install it first" >&2; exit 1; }

mkdir -p "$CONFIG_DIR" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
umask 077
# %q, because push.sh sources this file: a path with a space or a $(…), a & or a |
# is data here and would be code there.
{
  echo "# Written by mac/calendar/install.sh. Not a secret itself: it names a file that is."
  printf 'KUBECONFIG_PATH=%q\n' "$KUBECONFIG_PATH"
  printf 'CALENDAR_NAMESPACE=%q\n' "zy-assistant"
  printf 'CALENDAR_CONFIGMAP=%q\n' "zy-calendar"
  printf 'KUBECTL=%q\n' "$KUBECTL_PATH"
} > "$CONFIG"
umask 022

# A heredoc, not sed: bash substitutes and leaves & and | alone, while sed reads
# them as replacement and pattern syntax.
PUSH="$(pwd)/push.sh"
# A path can hold any character a filesystem allows, and this is XML: escape the
# three that would break it rather than assume a home directory is plain ASCII.
xml() { local v=$1; v=${v//&/&amp;}; v=${v//</&lt;}; v=${v//>/&gt;}; printf '%s' "$v"; }
APP_XML=$(xml "$APP"); PUSH_XML=$(xml "$(pwd)/push.sh"); LOG_XML=$(xml "$LOG")

cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by mac/calendar/install.sh: the paths below are literal, not patterns. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zy.assistant.calendar</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_XML</string>
    <string>--days</string>
    <string>2</string>
    <string>--exec</string>
    <string>$PUSH_XML</string>
  </array>
  <!-- Twice a day, not more: a calendar barely changes between two runs, and
       either snapshot still starts at today's midnight, so it covers today and
       tomorrow whichever one the pod reads. 07:30 lands before the 09:00
       briefing; 18:30 keeps tomorrow's answer current in the evening. RunAtLoad
       and no KeepAlive: a login pushes once, a failure waits for the next slot
       instead of spinning. A sleeping Mac runs the missed slot on wake. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

echo
echo "Written: $AGENT"
echo "Written: $CONFIG"
echo "Log:     $LOG"
echo
echo "Load it (asks for no permission if build.sh was run from a GUI session once):"
echo "  launchctl bootstrap gui/\$(id -u) $AGENT"
echo "Then check the log for 'pushed: N bytes':"
echo "  tail -f $LOG"
