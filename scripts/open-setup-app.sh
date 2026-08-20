#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/macos-helper/.build/debug/AppleCalendarMCPHelper.app"

bash "$ROOT_DIR/scripts/build-helper-app.sh" >/dev/stderr
/usr/bin/open -n "$APP_DIR" --args --setup
