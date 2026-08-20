import EventKit
import Foundation

struct BridgeError: Error {
    let code: String
    let message: String
    let suggestedAction: String
    let retryable: Bool

    init(
        code: String,
        message: String,
        suggestedAction: String,
        retryable: Bool = false
    ) {
        self.code = code
        self.message = message
        self.suggestedAction = suggestedAction
        self.retryable = retryable
    }

    func toJSON() -> [String: Any] {
        [
            "code": code,
            "message": message,
            "suggested_action": suggestedAction,
            "retryable": retryable
        ]
    }

    static func fromNative(_ error: Error) -> BridgeError {
        let nsError = error as NSError

        guard nsError.domain == EKErrorDomain,
              let code = EKError.Code(rawValue: nsError.code) else {
            return BridgeError(
                code: "EVENTKIT_OPERATION_FAILED",
                message: "EventKit operation failed.",
                suggestedAction: "Check Calendar permissions and retry."
            )
        }

        switch code {
        case .eventStoreNotAuthorized:
            return BridgeError(
                code: "CALENDAR_PERMISSION_DENIED",
                message: "Calendar access is not authorized.",
                suggestedAction: "Grant Calendar access in macOS settings and retry."
            )
        case .noCalendar, .calendarDoesNotAllowEvents:
            return BridgeError(
                code: "CALENDAR_NOT_FOUND",
                message: "The target calendar is unavailable for this EventKit operation.",
                suggestedAction: "Refresh calendars and choose an available writable calendar."
            )
        case .eventNotMutable,
             .calendarReadOnly,
             .calendarIsImmutable,
             .invitesCannotBeMoved,
             .procedureAlarmsNotMutable:
            return BridgeError(
                code: "PERMISSION_DENIED",
                message: "EventKit rejected the operation because the target item is not writable.",
                suggestedAction: "Choose a writable calendar or event and retry."
            )
        case .noStartDate,
             .noEndDate,
             .datesInverted,
             .invalidSpan,
             .invalidEntityType,
             .durationGreaterThanRecurrence,
             .alarmGreaterThanRecurrence,
             .startDateTooFarInFuture,
             .startDateCollidesWithOtherOccurrence,
             .objectBelongsToDifferentStore,
             .calendarHasNoSource,
             .calendarSourceCannotBeModified,
             .sourceDoesNotAllowCalendarAddDelete,
             .structuredLocationsNotSupported,
             .alarmProximityNotSupported,
             .sourceDoesNotAllowEvents,
             .sourceMismatch:
            return BridgeError(
                code: "INVALID_INPUT",
                message: "EventKit rejected the request parameters.",
                suggestedAction: "Validate the request fields and retry."
            )
        case .internalFailure:
            return BridgeError(
                code: "EVENTKIT_OPERATION_FAILED",
                message: "EventKit reported an internal failure.",
                suggestedAction: "Retry the operation or run diagnostics if the problem persists.",
                retryable: true
            )
        case .osNotSupported:
            return BridgeError(
                code: "EVENTKIT_OPERATION_FAILED",
                message: "This EventKit operation is not supported on the current macOS version.",
                suggestedAction: "Use a supported macOS version or avoid this operation."
            )
        default:
            return BridgeError(
                code: "EVENTKIT_OPERATION_FAILED",
                message: "EventKit rejected the operation.",
                suggestedAction: "Check Calendar state, permissions, and request fields before retrying."
            )
        }
    }
}
