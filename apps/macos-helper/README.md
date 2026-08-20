# macOS Helper

Swift EventKit bridge for Apple Calendar MCP.

The helper exposes a narrow line-delimited JSON interface over stdin/stdout.
Each request is one JSON object per line:

```json
{"id":"1","method":"permission_status","params":{}}
```

Each response is one JSON object per line:

```json
{"id":"1","success":true,"data":{}}
```

Supported bridge methods:

- `permission_status`
- `request_permission`
- `list_calendars`
- `list_events`
- `get_event`
- `create_event`
- `update_event`
- `delete_event`

This helper intentionally stays thin. Permission policy, calendar allowlists,
duplicate detection, conflict detection, idempotency, rollback, audit logging,
and confirmation gates remain TypeScript responsibilities.

## Calendar Permission Prompting

The SwiftPM executable embeds `../Info.plist` into the Mach-O
`__TEXT,__info_plist` section during `swift build`. For reliable macOS TCC
registration during development, run the helper from the generated `.app`
bundle. The bundle places the executable at:

```text
apps/macos-helper/.build/debug/AppleCalendarMCPHelper.app/Contents/MacOS/apple-calendar-mcp-helper
```

The MCP server should use the bundled executable path for
`APPLE_CALENDAR_MCP_HELPER`. When that path is inside `AppleCalendarMCPHelper.app`,
the TypeScript bridge launches the app through LaunchServices and speaks to it
over a local Unix domain socket. This keeps runtime EventKit calls under the
same TCC identity that receives Calendar permission.

Stable helper identifier:

```text
com.owensuyko.apple-calendar-mcp.helper
```

Build and check status:

```sh
npm run helper:permission-status
```

This command rebuilds the helper app and queries the app-hosted bridge. A
healthy authorized response includes:

```json
{"authorization_status":"authorized","bridge_process_mode":"app_socket","info_plist_detected":true}
```

Build and request Calendar permission through LaunchServices:

```sh
npm run helper:permission-request
```

This command launches `AppleCalendarMCPHelper.app` with `open -W -n` and writes
permission diagnostics after the app exits. Use this path when validating the
macOS prompt locally. Direct stdin/stdout execution is only for low-level bridge
debugging and can report a different TCC status than the app-hosted runtime.

During development, reset Calendar TCC state before re-testing the prompt:

```sh
tccutil reset Calendar
```

Then run `npm run helper:permission-request` again. On macOS 14 and newer the
helper uses `requestFullAccessToEvents`; on older supported macOS versions it
falls back to `requestAccess(to: .event)`.

Common failure modes:

- `info_plist_detected:false`: rebuild with `npm run helper:bundle` and verify
  `apps/macos-helper/Info.plist` is copied into the app bundle.
- `bridge_process_mode:"direct_stdio"` during MCP runtime: point
  `APPLE_CALENDAR_MCP_HELPER` at the executable inside
  `AppleCalendarMCPHelper.app`, not at a bare SwiftPM binary.
- `authorization_status:"not_determined"` after a request: run
  `tccutil reset Calendar`, then `npm run helper:permission-request` and accept
  the macOS prompt.
- `authorization_status:"denied"`: enable Calendar access in System Settings,
  then rerun `npm run helper:permission-status`.

## Native Setup App

Launch the setup window:

```sh
npm run helper:setup
```

The setup app provides onboarding, Calendar permission request, calendar
allowlist selection, permission mode selection, MCP client setup, verification,
settings, recovery instructions, reset controls, and config generation.
Generated files are written to:

```text
~/Library/Application Support/AppleCalendarMCP/config.json
~/Library/Application Support/AppleCalendarMCP/mcp.env
```

The generated config contains selected native calendar identifiers and setup
paths only. It does not store event notes, attendees, URLs, calendar titles, or
event bodies.

Load the generated environment file before starting the MCP server:

```sh
set -a
source "$HOME/Library/Application Support/AppleCalendarMCP/mcp.env"
set +a
npm start
```

The setup app reset button removes generated setup files and clears the visible
selection in the setup window.
