#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="$ROOT_DIR/apps/macos-helper"
BUILD_DIR="$HELPER_DIR/.build/debug"
APP_DIR="$BUILD_DIR/AppleCalendarMCPHelper.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

swift build --package-path "$HELPER_DIR"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$BUILD_DIR/apple-calendar-mcp-helper" "$MACOS_DIR/apple-calendar-mcp-helper"
cp "$HELPER_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"
printf 'APPL????' > "$CONTENTS_DIR/PkgInfo"
chmod 755 "$MACOS_DIR/apple-calendar-mcp-helper"

echo "$MACOS_DIR/apple-calendar-mcp-helper"
