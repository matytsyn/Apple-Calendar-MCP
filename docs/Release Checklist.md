# Release Checklist

## Versioning Strategy

- Use semantic versioning after public launch.
- `0.1.x` is release-candidate and early adopter territory.
- Tag releases as `vMAJOR.MINOR.PATCH`.
- Update `CHANGELOG.md` before tagging.
- Keep package versions aligned across workspaces unless a deliberate independent-versioning strategy is adopted later.

## Pre-Release Verification

Run:

```sh
npm run release:verify
```

This must pass:

- TypeScript build
- full test suite
- Swift helper bundle build
- client config generation
- client config validation

## Package Artifacts

Create artifacts:

```sh
npm run release:package
```

Expected output:

```text
dist/release/*.tgz
dist/release/SHA256SUMS.txt
```

Verify checksums:

```sh
cd dist/release
shasum -a 256 -c SHA256SUMS.txt
```

## Security Gates

- No secrets, API keys, private keys, or local user configs committed.
- No private calendar data in logs, snapshots, change feeds, diagnostics, or examples.
- stdout is protocol-clean during MCP startup.
- Blocked calendars are filtered server-side.
- Write tools enforce permission mode, allowlist, ambiguity, duplicate/conflict, idempotency, rollback, EventKit write, verification, audit, change feed, and semantic response order.
- Destructive actions require explicit confirmation where required.
- Recurring writes require explicit scope.
- Calendar content is treated as untrusted input.

## Performance Gates

- Long event reads are chunked.
- List responses and change feeds are paginated.
- Snapshot records are compact.
- SQLite indexes exist for allowlists, snapshots, changes, audit, rollback, and idempotency.
- Startup does not perform unnecessary EventKit reads.

## Installation Gates

- Native setup app opens.
- Calendar permission request works on a clean macOS account.
- Denied permission state shows recovery instructions.
- Calendar allowlist persists after app restart.
- Permission mode persists after app restart.
- Client configs are generated with absolute paths.
- Cursor, Codex, Claude, OpenClaw, and generic configs parse.
- At least one real MCP client discovers calendar tools.

## Documentation Gates

- README install path is accurate.
- Installation Guide matches the setup app.
- Security Specification reflects current enforcement.
- Technical Specification matches package boundaries and tool names.
- Changelog includes release notes.
- Screenshots are captured or explicitly marked as placeholders.

## Known Release Candidate Limitations

- Public npm publication still needs namespace confirmation and internal workspace package publish order validation.
- Signed and notarized macOS packaging is not yet implemented.
- Real-client smoke tests should be repeated on a clean macOS user account before public announcement.
