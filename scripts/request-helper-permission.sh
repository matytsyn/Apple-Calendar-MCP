#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/macos-helper/.build/debug/AppleCalendarMCPHelper.app"
OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/apple-calendar-mcp-permission.XXXXXX")"

bash "$ROOT_DIR/scripts/build-helper-app.sh" >/dev/stderr

/usr/bin/open -W -n "$APP_DIR" --args \
  --request-permission-and-exit \
  --permission-output "$OUTPUT_FILE"

if [[ -s "$OUTPUT_FILE" ]]; then
  cat "$OUTPUT_FILE"
else
  printf '%s\n' '{"success":false,"error":{"code":"HELPER_UNAVAILABLE","message":"Helper permission request did not produce diagnostics.","suggested_action":"Check whether macOS blocked launching the helper app bundle.","details":{}}}'
fi
