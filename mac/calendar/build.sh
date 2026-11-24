#!/usr/bin/env bash
# Builds zy-calendar-export.app: a bundle, because a bare binary gets no TCC dialog.
set -euo pipefail
cd "$(dirname "$0")"

APP=zy-calendar-export.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O main.swift -o "$APP/Contents/MacOS/zy-calendar-export" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
cp Info.plist "$APP/Contents/Info.plist"
# Ad-hoc, and once: rebuilding changes the signature, which can cost a new prompt.
codesign -s - --identifier com.zy.assistant.calendar --force "$APP/Contents/MacOS/zy-calendar-export"
codesign -s - --identifier com.zy.assistant.calendar --force "$APP"
echo "built $(pwd)/$APP"
