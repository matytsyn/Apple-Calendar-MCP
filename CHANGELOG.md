# Changelog

All notable changes to Apple Calendar MCP will be documented here.

This project uses semantic versioning after the first public release.

## [Unreleased]

### Added

- Release-candidate packaging workflow, checksum generation, and consolidated maintainer documentation.
- Native setup app documentation for permission grant, allowlists, client configuration, and verification.

### Changed

- Package metadata now uses `0.1.0` prerelease-candidate versions for local release artifacts.

### Security

- Release checklist includes stdout hygiene, allowlist enforcement, confirmation gates, and secret scan requirements.

## [0.1.0] - 2026-06-07

### Added

- Local-first MCP server for Apple Calendar.
- Swift EventKit helper and native macOS setup app.
- Calendar read, write, preview, rollback, snapshot, change-feed, diagnostics, and client configuration tools.
- Safety tests covering schemas, permissions, allowlists, duplicate detection, idempotency, rollback, audit records, snapshots, change feeds, recurring scope, semantic errors, stdout/stderr separation, oversized payloads, and prompt-injection handling.
