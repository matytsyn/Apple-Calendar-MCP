#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${1:-$ROOT_DIR/dist/release}"

cd "$ROOT_DIR"

npm run release:verify

mkdir -p "$ARTIFACT_DIR"
find "$ARTIFACT_DIR" -maxdepth 1 -type f -name '*.tgz' -delete
find "$ARTIFACT_DIR" -maxdepth 1 -type f -name 'SHA256SUMS.txt' -delete

npm pack --workspace packages/shared --pack-destination "$ARTIFACT_DIR"
npm pack --workspace packages/sqlite-store --pack-destination "$ARTIFACT_DIR"
npm pack --workspace packages/calendar-service --pack-destination "$ARTIFACT_DIR"
npm pack --workspace packages/mcp-server --pack-destination "$ARTIFACT_DIR"

(
  cd "$ARTIFACT_DIR"
  shasum -a 256 ./*.tgz > SHA256SUMS.txt
)

printf 'Release artifacts written to %s\n' "$ARTIFACT_DIR"
