# Scripts

- `build-helper-app.sh`: builds the Swift helper and bundles it as `AppleCalendarMCPHelper.app`.
- `open-setup-app.sh`: builds and opens the native setup app.
- `generate-client-configs.mjs`: generates and validates Phase 11 MCP client config examples.
- `request-helper-permission.sh`: opens the helper app in permission-request mode and prints diagnostics.
- `query-helper-bridge.mjs`: sends one JSON-line bridge method to the built helper.
- `verify-release.sh`: builds, tests, bundles the helper app, and validates client configs.
- `package-release.sh`: creates workspace npm tarballs and SHA-256 checksums in `dist/release/`.
