# Product Specification

## Overview

Apple Calendar MCP is a local-first MCP server that lets AI assistants read and manage Apple Calendar safely on macOS. It is intended for users of Claude, Codex, Cursor, OpenClaw, and other MCP-compatible clients who want calendar assistance without sending calendar data to a separate cloud service.

The product must feel trustworthy before it feels powerful. Users should understand what data is visible, which calendars are blocked, whether writes are allowed, and what changed.

## Product Goals

- Keep calendar data on the user's Mac.
- Use native EventKit instead of AppleScript/JXA as the primary calendar path.
- Let users choose exactly which calendars agents may access.
- Require safe write flows with validation, confirmation, rollback, audit, idempotency, and change visibility.
- Keep responses compact enough for agent workflows.
- Provide an onboarding setup app that a non-technical user can complete without reading docs.

## MVP Capabilities

- List calendars and reflect macOS Calendar permission state.
- List, search, and inspect events from allowed calendars only.
- Find free time across selected calendars.
- Preview, create, update, reschedule, and delete events.
- Require explicit confirmation or preview-confirm flow for writes.
- Detect ambiguous requests, duplicates, and conflicts before writing. Conflict results are surfaced to the caller as safety information, while ordinary overlapping events remain valid because Apple Calendar supports parallel events. Duplicate and idempotency safeguards still prevent accidental repeated writes.
- Maintain rollback records, audit records, idempotency records, snapshots, and change feeds.
- Generate MCP client configs for Claude, Codex, Cursor, OpenClaw, and generic clients.
- Provide a native macOS setup app for permission, allowlist, mode selection, config generation, and verification.

## User Experience Requirements

The first-run flow is:

1. Welcome and local-first explanation.
2. Calendar permission explanation and request.
3. Calendar allowlist selection.
4. Permission mode selection.
5. MCP client configuration.
6. Verification and test connection.
7. Completion and settings entry point.

The setup app must avoid unnecessary UI complexity. It should use clear language, explicit warnings for destructive capability, dark/light mode support, keyboard accessibility, and immediate persistence for settings changes.

## Permission Modes

- Read Only: agents can view calendars and events.
- Ask Before Write: recommended default; agents must receive confirmation before writes.
- Trusted Write: agents may create and update events without additional confirmation where policy allows.
- Full Write: includes delete capability and must show a clear warning.

MVP write tools still require explicit confirmation or preview-confirm flow. Permission modes are persisted in local config and enforced by the server, not only by the setup UI.

## Roadmap

- Signed and notarized macOS distribution.
- Public npm publication and verified `npx apple-calendar-mcp` setup.
- End-to-end smoke testing against real MCP clients.
- More performance profiling for large calendars and long-range reads.
- Better public screenshots and installation videos.

## Cross-References

- Technical details: [Technical Specification](Technical%20Specification.md)
- Security model: [Security Specification](Security%20Specification.md)
- Installation: [Installation Guide](Installation%20Guide.md)
- Release gates: [Release Checklist](Release%20Checklist.md)
