import EventKit
import Foundation

final class EventKitBridge {
    private let expectedBundleIdentifier = "com.owensuyko.apple-calendar-mcp.helper"
    private let processMode: String
    private let eventStore = EKEventStore()
    private let isoFormatter = ISO8601DateFormatter()
    private let isoFormatterWithoutFractionalSeconds = ISO8601DateFormatter()

    init(processMode: String = "direct_stdio") {
        self.processMode = processMode
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        isoFormatter.timeZone = TimeZone(secondsFromGMT: 0)
        isoFormatterWithoutFractionalSeconds.formatOptions = [.withInternetDateTime]
        isoFormatterWithoutFractionalSeconds.timeZone = TimeZone(secondsFromGMT: 0)
    }

    func handle(method: String, params: [String: Any]) throws -> Any {
        switch method {
        case "permission_status":
            return permissionStatus()
        case "request_permission":
            return try requestPermission()
        case "list_calendars":
            return listCalendars()
        case "list_events":
            return try listEvents(params: params)
        case "get_event":
            return try getEvent(params: params)
        case "create_event":
            return try createEvent(params: params)
        case "update_event":
            return try updateEvent(params: params)
        case "delete_event":
            return try deleteEvent(params: params)
        default:
            throw BridgeError(
                code: "INVALID_INPUT",
                message: "Unknown bridge method.",
                suggestedAction: "Use a supported EventKit bridge method."
            )
        }
    }

    private func permissionStatus() -> [String: Any] {
        permissionDiagnostics(
            status: EKEventStore.authorizationStatus(for: .event),
            requestAttempted: false,
            requestApiUsed: nil,
            granted: nil
        )
    }

    private func requestPermission() throws -> [String: Any] {
        var completed = false
        var granted = false
        var requestError: Error?
        let requestApiUsed: String

        if #available(macOS 14.0, *) {
            requestApiUsed = "requestFullAccessToEvents"
            eventStore.requestFullAccessToEvents { didGrant, error in
                granted = didGrant
                requestError = error
                completed = true
            }
        } else {
            requestApiUsed = "requestAccess(to:.event)"
            eventStore.requestAccess(to: .event) { didGrant, error in
                granted = didGrant
                requestError = error
                completed = true
            }
        }

        while !completed {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }

        if let requestError {
            throw requestError
        }

        return permissionDiagnostics(
            status: EKEventStore.authorizationStatus(for: .event),
            requestAttempted: true,
            requestApiUsed: requestApiUsed,
            granted: granted
        )
    }

    private func listCalendars() -> [[String: Any]] {
        eventStore.calendars(for: .event).map(calendarDTO)
    }

    private func listEvents(params: [String: Any]) throws -> [[String: Any]] {
        let start = try requiredDate(params, key: "start")
        let end = try requiredDate(params, key: "end")

        guard start < end else {
            throw BridgeError(
                code: "INVALID_INPUT",
                message: "Event list start must be before end.",
                suggestedAction: "Provide an ordered start and end timestamp."
            )
        }

        let calendars = try calendarsFromParams(params)
        let predicate = eventStore.predicateForEvents(
            withStart: start,
            end: end,
            calendars: calendars
        )

        return eventStore.events(matching: predicate).map(eventDTO)
    }

    private func getEvent(params: [String: Any]) throws -> [String: Any] {
        let event = try requiredEvent(params)
        return eventDTO(event)
    }

    private func createEvent(params: [String: Any]) throws -> [String: Any] {
        let event = EKEvent(eventStore: eventStore)
        event.calendar = try requiredCalendar(params)
        event.title = try requiredString(params, key: "title")
        event.startDate = try requiredDate(params, key: "start")
        event.endDate = try requiredDate(params, key: "end")
        event.isAllDay = optionalBool(params, key: "is_all_day") ?? false
        applyOptionalFields(to: event, from: params)

        try save(event, span: span(from: params))
        return eventDTO(event)
    }

    private func updateEvent(params: [String: Any]) throws -> [String: Any] {
        let event = try requiredEvent(params)
        guard let changes = params["changes"] as? [String: Any] else {
            throw BridgeError(
                code: "INVALID_INPUT",
                message: "Update request is missing changes.",
                suggestedAction: "Provide a changes object."
            )
        }

        if let title = changes["title"] as? String {
            event.title = title
        }
        if let startValue = changes["start"] as? String {
            event.startDate = try parseDate(startValue, key: "start")
        }
        if let endValue = changes["end"] as? String {
            event.endDate = try parseDate(endValue, key: "end")
        }
        if let isAllDay = changes["is_all_day"] as? Bool {
            event.isAllDay = isAllDay
        }
        if let calendarId = changes["native_calendar_id"] as? String {
            event.calendar = try calendar(withIdentifier: calendarId)
        }

        applyOptionalFields(to: event, from: changes)
        try save(event, span: span(from: params))

        return eventDTO(event)
    }

    private func deleteEvent(params: [String: Any]) throws -> [String: Any] {
        let event = try requiredEvent(params)
        let nativeEventId: String
        if let eventIdentifier = event.eventIdentifier {
            nativeEventId = eventIdentifier
        } else {
            nativeEventId = try requiredString(params, key: "native_event_id")
        }

        try eventStore.remove(event, span: span(from: params), commit: true)

        return [
            "native_event_id": nativeEventId,
            "deleted": true
        ]
    }

    private func save(_ event: EKEvent, span: EKSpan) throws {
        guard event.startDate < event.endDate || event.isAllDay else {
            throw BridgeError(
                code: "INVALID_INPUT",
                message: "Event start must be before end.",
                suggestedAction: "Provide ordered event timestamps."
            )
        }

        try eventStore.save(event, span: span, commit: true)
    }

    private func applyOptionalFields(to event: EKEvent, from params: [String: Any]) {
        if let location = params["location"] as? String {
            event.location = location
        }
        if let notes = params["notes"] as? String {
            event.notes = notes
        }
        if let url = params["url"] as? String {
            event.url = URL(string: url)
        }
        if let timezone = params["timezone"] as? String,
           let timeZone = TimeZone(identifier: timezone) {
            event.timeZone = timeZone
        }
    }

    private func calendarsFromParams(_ params: [String: Any]) throws -> [EKCalendar]? {
        guard let ids = params["native_calendar_ids"] as? [String] else {
            return nil
        }

        return try ids.map(calendar)
    }

    private func requiredCalendar(_ params: [String: Any]) throws -> EKCalendar {
        try calendar(withIdentifier: requiredString(params, key: "native_calendar_id"))
    }

    private func calendar(withIdentifier identifier: String) throws -> EKCalendar {
        guard let calendar = eventStore.calendar(withIdentifier: identifier) else {
            throw BridgeError(
                code: "CALENDAR_NOT_FOUND",
                message: "Calendar was not found by native identifier.",
                suggestedAction: "Refresh calendars and retry with an available native calendar identifier."
            )
        }

        return calendar
    }

    private func requiredEvent(_ params: [String: Any]) throws -> EKEvent {
        let identifier = try requiredString(params, key: "native_event_id")
        guard let event = eventStore.event(withIdentifier: identifier) else {
            throw BridgeError(
                code: "EVENT_NOT_FOUND",
                message: "Event was not found by native identifier.",
                suggestedAction: "Refresh events and retry with an available native event identifier."
            )
        }

        return event
    }

    private func requiredString(_ params: [String: Any], key: String) throws -> String {
        guard let value = params[key] as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeError(
                code: "INVALID_INPUT",
                message: "Missing required string parameter: \(key).",
                suggestedAction: "Provide \(key) as a non-empty string."
            )
        }

        return value
    }

    private func optionalBool(_ params: [String: Any], key: String) -> Bool? {
        params[key] as? Bool
    }

    private func requiredDate(_ params: [String: Any], key: String) throws -> Date {
        try parseDate(requiredString(params, key: key), key: key)
    }

    private func parseDate(_ value: String, key: String) throws -> Date {
        if let date = isoFormatter.date(from: value) ?? isoFormatterWithoutFractionalSeconds.date(from: value) {
            return date
        }

        throw BridgeError(
            code: "INVALID_INPUT",
            message: "Invalid ISO 8601 timestamp for \(key).",
            suggestedAction: "Provide \(key) as an ISO 8601 timestamp with timezone."
        )
    }

    private func formatDate(_ date: Date?) -> Any {
        guard let date else {
            return NSNull()
        }

        return isoFormatter.string(from: date)
    }

    private func span(from params: [String: Any]) -> EKSpan {
        switch params["span"] as? String {
        case "future_events":
            return .futureEvents
        default:
            return .thisEvent
        }
    }

    private func authorizationStatusString(_ status: EKAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "not_determined"
        case .restricted:
            return "restricted"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        case .fullAccess:
            return "authorized"
        case .writeOnly:
            return "write_only"
        @unknown default:
            return "unknown"
        }
    }

    private func permissionDiagnostics(
        status: EKAuthorizationStatus,
        requestAttempted: Bool,
        requestApiUsed: String?,
        granted: Bool?
    ) -> [String: Any] {
        let authorizationStatus = authorizationStatusString(status)
        var data: [String: Any] = [
            "calendar_permission": authorizationStatus,
            "authorization_status": authorizationStatus,
            "request_attempted": requestAttempted,
            "request_api_used": requestApiUsed ?? NSNull(),
            "helper_bundle_identifier": Bundle.main.bundleIdentifier ?? expectedBundleIdentifier,
            "info_plist_detected": infoPlistDetected(),
            "bridge_process_mode": processMode
        ]

        if let granted {
            data["granted"] = granted
        }

        return data
    }

    private func infoPlistDetected() -> Bool {
        let bundle = Bundle.main
        let bundleIdentifier = bundle.bundleIdentifier
            ?? bundle.object(forInfoDictionaryKey: "CFBundleIdentifier") as? String

        return bundleIdentifier == expectedBundleIdentifier
            && bundle.object(forInfoDictionaryKey: "NSCalendarsUsageDescription") is String
            && bundle.object(forInfoDictionaryKey: "NSCalendarsFullAccessUsageDescription") is String
    }

    private func calendarDTO(_ calendar: EKCalendar) -> [String: Any] {
        [
            "native_calendar_id": calendar.calendarIdentifier,
            "title": calendar.title,
            "source_title": calendar.source.title,
            "allows_content_modifications": calendar.allowsContentModifications,
            "is_subscribed": calendar.type == .subscription,
            "color": colorString(calendar.cgColor)
        ]
    }

    private func eventDTO(_ event: EKEvent) -> [String: Any] {
        [
            "native_event_id": event.eventIdentifier ?? "",
            "calendar_item_id": event.calendarItemIdentifier,
            "native_calendar_id": event.calendar?.calendarIdentifier ?? "",
            "title": event.title ?? "",
            "start": formatDate(event.startDate),
            "end": formatDate(event.endDate),
            "timezone": event.timeZone?.identifier ?? TimeZone.current.identifier,
            "is_all_day": event.isAllDay,
            "location": event.location ?? NSNull(),
            "notes": event.notes ?? NSNull(),
            "url": event.url?.absoluteString ?? NSNull(),
            "has_recurrence_rules": event.hasRecurrenceRules,
            "last_modified_at": formatDate(event.lastModifiedDate)
        ]
    }

    private func colorString(_ color: CGColor?) -> Any {
        guard let color,
              let components = color.components,
              components.count >= 3 else {
            return NSNull()
        }

        let red = Int(round(components[0] * 255))
        let green = Int(round(components[1] * 255))
        let blue = Int(round(components[2] * 255))
        return String(format: "#%02X%02X%02X", red, green, blue)
    }
}
