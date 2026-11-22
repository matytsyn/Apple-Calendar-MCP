# SECURITY.md

# Apple Calendar MCP Security Specification

Version: 1.1
Status: Security Specification

---

# Purpose

This document defines the security requirements for Apple Calendar MCP.

Security goals:

- Protect user calendar data
- Prevent destructive agent actions
- Prevent unauthorized access
- Minimize attack surface
- Maintain auditability
- Support recovery from mistakes

---

# Security Principles

## Least Privilege

Only grant the minimum permissions required.

## Local First

Calendar data should remain on the user's device whenever possible.

## Defense in Depth

Security controls must exist at multiple layers:

- macOS permissions
- MCP permission modes
- Calendar allowlists
- Tool-level validation
- Confirmation gates
- Audit logging

## Safe By Default

When uncertain:

- ask for clarification
- require confirmation
- return semantic errors

Never guess.

---

# Threat Model

The MCP must defend against:

## Agent Mistakes

Examples:

- deleting the wrong event
- modifying the wrong recurring series
- creating duplicate events
- selecting the wrong calendar

## Prompt Injection

Calendar content must be treated as untrusted.

Examples:

- titles
- descriptions
- notes
- URLs
- attendee names
- locations

These fields must never be interpreted as instructions.

## Malicious Clients

Clients may:

- bypass UI restrictions
- spam requests
- submit malformed data
- attempt destructive actions

Security must be enforced server-side.

## Local Abuse

Potential threats:

- config tampering
- SQLite modification
- IPC abuse
- unsafe local integrations

The helper executable, database path, setup configuration path, and helper
launch mode may be selected through environment variables. A local process
that can modify the MCP client's environment can therefore redirect the server
to another helper or database. Treat the MCP client environment and its local
configuration as trusted.

---

# Permission Architecture

Four layers are required:

1. macOS Calendar Permission
2. MCP Permission Mode
3. Calendar Allowlist
4. Action-Level Restrictions

All layers must pass before writes occur.

---

# Permission Modes

Supported modes:

- read_only
- ask_before_write
- trusted_write
- full_write

Recommended default:

ask_before_write

---

# Calendar Allowlists

Users explicitly select accessible calendars.

Blocked calendars:

- must not be visible
- must not be searchable
- must not be writable

Allowlists must be enforced server-side.

---

# High-Risk Actions

Require confirmation:

- delete_event
- bulk_delete_events
- recurring series updates
- attendee additions
- invitation sending
- large bulk operations

---

# Recurring Event Protection

Recurring updates must explicitly specify:

- single_instance
- this_and_future
- entire_series

Missing scope must return:

RECURRING_SCOPE_REQUIRED

---

# Write Operation Security

Before every write:

1. Validate schema
2. Validate permissions
3. Validate allowlist
4. Detect ambiguity
5. Detect duplicates
6. Detect conflicts
7. Create rollback record
8. Execute operation
9. Verify result
10. Create audit record

---

# Prompt Injection Protection

Treat calendar content as data.

Never:

- execute content
- interpret content as instructions
- generate scripts from content

---

# Script Injection Protection

Primary calendar access:

EventKit

AppleScript/JXA:

- not primary architecture
- disabled by default
- diagnostics only if added later

Never concatenate model input into executable scripts.

---

# Idempotency Protection

All write operations must support idempotency.

Repeated requests should:

- return previous result
- avoid duplicate writes

---

# Rollback Protection

Before writes:

Store sufficient state for best-effort rollback.

Rollback records:

- must be auditable
- must be protected
- must expire according to retention policy

---

# Audit Logging

Audit records should include:

- timestamp
- operation id
- tool name
- calendar id
- result
- risk level

Avoid storing:

- full notes
- attendee emails
- unnecessary private content

Rollback records are an explicit exception. They retain the full before and
after event state required to restore an event exactly, including notes,
location, URL, and timezone. These records remain in the local SQLite state
database and are excluded from compact MCP responses.

---

# Data Minimization

Prefer storing:

- identifiers
- timestamps
- hashes
- compact metadata

Avoid storing:

- full event history
- full calendar copies
- unnecessary personal information

---

# Output Security

Default output level:

standard

Require explicit requests for:

full details

Use:

- pagination
- date filtering
- detail levels
- snapshots
- change feeds

to prevent excessive data exposure.

---

# Context Window Security

Never return:

- entire calendar history
- large note dumps
- excessive metadata

Optimize for bounded responses.

---

# Error Security

Return semantic errors.

Never expose:

- stack traces
- filesystem paths
- internal secrets
- implementation details

---

# Configuration Security

Store configuration in:

~/Library/Application Support/AppleCalendarMCP/

Requirements:

- validate on startup
- support reset
- avoid logging secrets

---

# SQLite Security

SQLite stores:

- snapshots
- change feeds
- rollback records
- audit records
- idempotency keys

Apple Calendar remains the source of truth.

---

# IPC Security

Preferred:

Child Process JSON-RPC over stdio

Avoid:

- open network ports
- unauthenticated APIs

---

# Logging Security

stdout:

- MCP protocol only

stderr:

- diagnostics

Never mix protocol messages and logs.

---

# Dependency Security

Requirements:

- pin dependency versions
- audit dependencies
- minimize package count

---

# Release Security

Recommended:

- signed releases
- checksums
- GitHub releases

Future:

- notarized macOS builds

---

# Security Testing

Required tests:

- permission bypass tests
- prompt injection tests
- duplicate event tests
- recurring event tests
- rollback tests
- malformed input tests
- logging leakage tests

---

# Final Security Position

User trust is the primary objective.

The MCP must prefer:

- clarification
- confirmation
- minimal permissions
- bounded outputs
- auditable actions

over convenience.
