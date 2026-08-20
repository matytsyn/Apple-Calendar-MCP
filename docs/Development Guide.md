# Development Guide

## Engineering Priorities

When choices conflict, use this order:

1. Security
2. Reliability
3. User trust
4. MCP compliance
5. Maintainability
6. Performance
7. Developer convenience

Developer convenience is never a reason to bypass permission checks, allowlists, confirmation gates, rollback records, audit records, idempotency, or semantic errors.

## Local Setup

```sh
npm install
npm run build
npm test
npm run helper:bundle
npm run helper:setup
```

For MCP client config work:

```sh
npm run client-configs:generate
npm run client-configs:validate
npm run client-configs:diagnose
```

## Package Boundaries

- Shared schemas live in `packages/shared`.
- Persistence and migrations live in `packages/sqlite-store`.
- Calendar business rules live in `packages/calendar-service`.
- MCP protocol code lives in `packages/mcp-server`.
- Native EventKit and setup UI code lives in `apps/macos-helper`.
- Scripts must stay small, documented, and release-safe.

Avoid duplicate utilities across packages. Prefer moving a shared contract into `packages/shared` only when multiple packages genuinely need it.

## Testing Expectations

Run the full suite before handoff:

```sh
npm test
```

Safety-critical coverage must include:

- schemas
- permissions
- allowlists
- duplicate detection
- idempotency
- rollback records
- audit records
- snapshots
- change feeds
- recurring scope
- semantic errors
- stdout/stderr separation
- oversized payload rejection
- prompt injection handling

## Documentation Expectations

Update docs when behavior changes:

- Product behavior: [Product Specification](Product%20Specification.md)
- Technical contracts: [Technical Specification](Technical%20Specification.md)
- Security behavior: [Security Specification](Security%20Specification.md)
- User setup: [Installation Guide](Installation%20Guide.md)
- Release process: [Release Checklist](Release%20Checklist.md)

## Release Verification

```sh
npm run release:verify
npm run release:package
```

`release:verify` builds, tests, bundles the helper app, generates client configs, and validates the generated configs. `release:package` also creates npm tarballs and SHA-256 checksums.
