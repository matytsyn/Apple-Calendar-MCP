import AppKit
import Darwin
import EventKit
import Foundation
import SwiftUI

final class SetupAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let model = SetupModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let contentView = SetupView(model: model)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.title = "Apple Calendar MCP"
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

final class SetupModel: ObservableObject {
    @Published var currentStep: SetupStep = .welcome
    @Published var showSettings = false
    @Published var permissionStatus = "not_checked"
    @Published var requestApiUsed: String?
    @Published var infoPlistDetected = false
    @Published var bridgeProcessMode = "setup_app"
    @Published var calendars: [SetupCalendar] = []
    @Published var allowedCalendarIds = Set<String>()
    @Published var permissionMode: SetupPermissionMode = .askBeforeWrite
    @Published var selectedClient: SetupClient = .cursor
    @Published var installPreview: ClientInstallPreview?
    @Published var verificationRows: [VerificationRow] = []
    @Published var connectedClientName = "Not selected"
    @Published var isBusy = false
    @Published var isTestingConnection = false
    @Published var statusMessage = "Ready."
    @Published var configPath = SetupPaths.configFile.path
    @Published var envPath = SetupPaths.envFile.path

    private let bridge = EventKitBridge(processMode: "setup_app")

    init() {
        loadExistingConfig()
        refresh()
    }

    var selectedCalendars: [SetupCalendar] {
        calendars.filter { allowedCalendarIds.contains($0.nativeCalendarId) }
    }

    var selectedCalendarCountText: String {
        "\(allowedCalendarIds.count) \(allowedCalendarIds.count == 1 ? "calendar" : "calendars") selected"
    }

    var hasCalendarPermission: Bool {
        permissionStatus == "authorized" || permissionStatus == "write_only"
    }

    var canContinueFromCurrentStep: Bool {
        switch currentStep {
        case .welcome:
            return true
        case .permission:
            return hasCalendarPermission
        case .calendars:
            return !allowedCalendarIds.isEmpty
        case .permissionMode:
            return true
        case .clientSetup:
            return true
        case .verification:
            return verificationRows.filter(\.isRequired).allSatisfy(\.isPassing)
        case .complete:
            return true
        }
    }

    var healthRows: [HealthRow] {
        [
            HealthRow(label: "Calendar permission", value: permissionStatus),
            HealthRow(label: "Info.plist", value: infoPlistDetected ? "detected" : "missing"),
            HealthRow(label: "Bridge mode", value: bridgeProcessMode),
            HealthRow(label: "Calendars visible", value: "\(calendars.count)"),
            HealthRow(label: "Allowed calendars", value: "\(allowedCalendarIds.count)"),
            HealthRow(label: "Permission mode", value: permissionMode.title),
            HealthRow(label: "Config file", value: FileManager.default.fileExists(atPath: configPath) ? "generated" : "not generated")
        ]
    }

    func goBack() {
        guard let previous = currentStep.previous else {
            return
        }
        currentStep = previous
    }

    func continueForward() {
        if currentStep == .calendars || currentStep == .permissionMode {
            writeCurrentConfig(allowEmptyAllowlist: false)
        }
        if currentStep == .clientSetup {
            connectedClientName = selectedClient.title
        }
        if let next = currentStep.next {
            currentStep = next
        }
    }

    func learnMore() {
        NSWorkspace.shared.open(SetupPaths.documentationURL)
    }

    func openSystemSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") {
            NSWorkspace.shared.open(url)
        }
    }

    func launchDocumentation() {
        NSWorkspace.shared.open(SetupPaths.documentationURL)
    }

    func done() {
        NSApplication.shared.terminate(nil)
    }

    func refresh() {
        run {
            let permission = try self.bridge.handle(method: "permission_status", params: [:])
            self.applyPermission(permission)

            let calendarObjects = try self.visibleCalendars()
            let calendars = calendarObjects.compactMap(SetupCalendar.init)
            await MainActor.run {
                self.calendars = calendars
                self.allowedCalendarIds.formIntersection(Set(calendars.map(\.nativeCalendarId)))
                self.statusMessage = "Health refreshed."
            }
            self.updateConfigAfterSettingsChange()
        }
    }

    func requestPermission() {
        run {
            let permission = try self.bridge.handle(method: "request_permission", params: [:])
            self.applyPermission(permission)
            await MainActor.run {
                self.statusMessage = self.hasCalendarPermission ? "Calendar Access Granted." : "Calendar access was not granted."
            }
            await MainActor.run {
                self.refresh()
            }
        }
    }

    func setAllowed(_ calendar: SetupCalendar, isAllowed: Bool) {
        if isAllowed {
            allowedCalendarIds.insert(calendar.nativeCalendarId)
        } else {
            allowedCalendarIds.remove(calendar.nativeCalendarId)
        }
        updateConfigAfterSettingsChange()
    }

    func selectAllCalendars() {
        allowedCalendarIds = Set(calendars.map(\.nativeCalendarId))
        updateConfigAfterSettingsChange()
    }

    func clearAllCalendars() {
        allowedCalendarIds.removeAll()
        updateConfigAfterSettingsChange(allowEmptyAllowlist: true)
    }

    func allowAllCalendars() {
        selectAllCalendars()
        statusMessage = "All visible calendars are selected. You can remove any calendar before continuing."
    }

    func setPermissionMode(_ mode: SetupPermissionMode) {
        permissionMode = mode
        updateConfigAfterSettingsChange()
    }

    func copySelectedClientConfig() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(selectedClient.configurationSnippet, forType: .string)
        statusMessage = "Copied \(selectedClient.title) configuration."
    }

    func previewInstallSelectedClient() {
        guard selectedClient.supportsAutomaticInstall else {
            installPreview = nil
            statusMessage = "\(selectedClient.title) uses manual copy/paste setup."
            return
        }

        installPreview = selectedClient.installPreview
        statusMessage = "Review the \(selectedClient.title) install preview before applying changes."
    }

    func installSelectedClientAfterPreview() {
        guard let preview = installPreview, preview.client == selectedClient else {
            statusMessage = "Preview the installation before applying changes."
            return
        }

        let alert = NSAlert()
        alert.messageText = "Install into \(selectedClient.title)?"
        alert.informativeText = "This will modify \(preview.destinationPath). Review the preview before continuing."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else {
            statusMessage = "Installation cancelled."
            return
        }

        do {
            try selectedClient.installConfiguration()
            connectedClientName = selectedClient.title
            statusMessage = "Installed \(selectedClient.title) configuration."
            installPreview = nil
        } catch {
            statusMessage = "Install failed: \(error.localizedDescription)"
        }
    }

    func generateConfig() {
        writeCurrentConfig(allowEmptyAllowlist: false)
    }

    func resetConfig() {
        run {
            try SetupConfigWriter.reset()
            await MainActor.run {
                self.allowedCalendarIds.removeAll()
                self.statusMessage = "Reset generated config and cleared this setup allowlist."
            }
        }
    }

    func runVerification() {
        updateVerificationRows(
            mcpPreflight: MCPServerPreflight(
                startupSucceeded: false,
                stdoutClean: true,
                detail: "Run Test Connection to check MCP server startup.",
                isRequired: false
            )
        )
    }

    func runTestConnection() {
        guard !isTestingConnection else {
            return
        }

        isTestingConnection = true
        isBusy = true
        statusMessage = "Running test connection..."
        updateVerificationRows(
            mcpPreflight: MCPServerPreflight(
                startupSucceeded: false,
                stdoutClean: true,
                detail: "Checking MCP server startup...",
                isRequired: false
            ),
            statusMessage: "Running test connection..."
        )

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else {
                return
            }

            do {
                let permission = try self.bridge.handle(method: "permission_status", params: [:])
                let calendarObjects = try self.visibleCalendars()
                let calendars = calendarObjects.compactMap(SetupCalendar.init)
                let mcpPreflight = SetupPaths.mcpServerPreflight()

                DispatchQueue.main.async {
                    self.applyPermission(permission)
                    self.calendars = calendars
                    self.allowedCalendarIds.formIntersection(Set(calendars.map(\.nativeCalendarId)))
                    self.updateVerificationRows(mcpPreflight: mcpPreflight)
                    self.updateConfigAfterSettingsChange()
                    self.isTestingConnection = false
                    self.isBusy = false
                }
            } catch let error as BridgeError {
                DispatchQueue.main.async {
                    self.statusMessage = "\(error.message) \(error.suggestedAction)"
                    self.isTestingConnection = false
                    self.isBusy = false
                }
            } catch {
                DispatchQueue.main.async {
                    self.statusMessage = "Test connection failed: \(error.localizedDescription)"
                    self.isTestingConnection = false
                    self.isBusy = false
                }
            }
        }
    }

    private func updateVerificationRows(
        mcpPreflight: MCPServerPreflight,
        statusMessage explicitStatusMessage: String? = nil
    ) {
        let rows = [
            VerificationRow(label: "Calendar access working", isPassing: hasCalendarPermission, detail: permissionStatus),
            VerificationRow(label: "EventKit check", isPassing: hasCalendarPermission && !calendars.isEmpty, detail: calendars.isEmpty ? "No calendars visible" : "\(calendars.count) calendars visible"),
            VerificationRow(label: "SQLite check", isPassing: SetupPaths.isAppSupportWritable, detail: SetupPaths.appSupportDirectory.path),
            VerificationRow(label: "Calendars selected", isPassing: !allowedCalendarIds.isEmpty, detail: selectedCalendarCountText),
            VerificationRow(label: "Permission mode configured", isPassing: true, detail: permissionMode.title),
            VerificationRow(label: "MCP server startup", isPassing: mcpPreflight.startupSucceeded, detail: mcpPreflight.detail, isRequired: mcpPreflight.isRequired),
            VerificationRow(label: "MCP configuration generated", isPassing: FileManager.default.fileExists(atPath: configPath), detail: configPath),
            VerificationRow(label: "stdout/stderr separation", isPassing: mcpPreflight.stdoutClean, detail: mcpPreflight.stdoutClean ? "No startup output written to stdout" : "Unexpected stdout during startup", isRequired: mcpPreflight.isRequired),
            VerificationRow(label: "Allowlist validation", isPassing: allowlistIsValid, detail: allowlistIsValid ? "All selected calendars are visible" : "One or more selected calendars are unavailable")
        ]

        verificationRows = rows
        statusMessage = explicitStatusMessage ?? (rows.filter(\.isRequired).allSatisfy(\.isPassing) ? "Required verification passed." : "Verification needs attention.")
    }

    private var allowlistIsValid: Bool {
        let visibleIds = Set(calendars.map(\.nativeCalendarId))
        return !allowedCalendarIds.isEmpty && allowedCalendarIds.isSubset(of: visibleIds)
    }

    private func updateConfigAfterSettingsChange(allowEmptyAllowlist: Bool = true) {
        writeCurrentConfig(allowEmptyAllowlist: allowEmptyAllowlist, quiet: true)
    }

    private func writeCurrentConfig(allowEmptyAllowlist: Bool, quiet: Bool = false) {
        let selected = selectedCalendars
        guard allowEmptyAllowlist || !selected.isEmpty else {
            statusMessage = "Select at least one calendar before continuing."
            return
        }

        do {
            try SetupConfigWriter.write(calendars: selected, permissionMode: permissionMode)
            if !quiet {
                statusMessage = "Generated MCP configuration."
            }
        } catch {
            statusMessage = "Config generation failed: \(error.localizedDescription)"
        }
    }

    private func visibleCalendars() throws -> [[String: Any]] {
        let permission = EKEventStore.authorizationStatus(for: .event)
        if permission == .notDetermined || permission == .denied || permission == .restricted {
            return []
        }

        return try bridge.handle(method: "list_calendars", params: [:]) as? [[String: Any]] ?? []
    }

    private func run(_ operation: @escaping () async throws -> Void) {
        isBusy = true
        Task {
            do {
                try await operation()
            } catch let error as BridgeError {
                await MainActor.run {
                    self.statusMessage = "\(error.message) \(error.suggestedAction)"
                }
            } catch {
                await MainActor.run {
                    self.statusMessage = "Setup failed: \(error.localizedDescription)"
                }
            }

            await MainActor.run {
                self.isBusy = false
            }
        }
    }

    private func loadExistingConfig() {
        guard let data = try? Data(contentsOf: SetupPaths.configFile),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        if let ids = object["allowed_native_calendar_ids"] as? [String] {
            allowedCalendarIds = Set(ids)
        }
        if let mode = object["permission_mode"] as? String,
           let parsedMode = SetupPermissionMode(rawValue: mode) {
            permissionMode = parsedMode
        }
    }

    private func applyPermission(_ value: Any) {
        guard let data = value as? [String: Any] else {
            permissionStatus = "unknown"
            return
        }

        permissionStatus = data["authorization_status"] as? String ?? "unknown"
        requestApiUsed = data["request_api_used"] as? String
        infoPlistDetected = data["info_plist_detected"] as? Bool ?? false
        bridgeProcessMode = data["bridge_process_mode"] as? String ?? "setup_app"
    }
}

struct SetupView: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            if model.showSettings {
                SettingsView(model: model)
            } else {
                WizardView(model: model)
            }
            Divider()
            footer
        }
        .frame(minWidth: 820, minHeight: 620)
    }

    private var topBar: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Apple Calendar MCP")
                    .font(.title2.weight(.semibold))
                Text(model.showSettings ? "Settings" : model.currentStep.title)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(model.showSettings ? "Setup Wizard" : "Manage Settings") {
                model.showSettings.toggle()
                if !model.showSettings {
                    model.currentStep = .welcome
                }
            }
            .disabled(model.isBusy)
        }
        .padding(20)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text(model.statusMessage)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
            if !model.showSettings {
                Button("Back") {
                    model.goBack()
                }
                .disabled(model.currentStep.previous == nil || model.isBusy)

                Button(model.currentStep == .complete ? "Done" : "Continue") {
                    if model.currentStep == .complete {
                        model.done()
                    } else {
                        model.continueForward()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canContinueFromCurrentStep || model.isBusy)
            }
        }
        .padding(20)
    }
}

struct WizardView: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        HStack(spacing: 0) {
            stepList
            Divider()
            ScrollView {
                currentStep
                    .padding(28)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var stepList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(SetupStep.allCases) { step in
                HStack(spacing: 8) {
                    Image(systemName: step.index <= model.currentStep.index ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(step == model.currentStep ? .blue : .secondary)
                    Text(step.sidebarTitle)
                        .font(.callout)
                }
                .padding(.vertical, 6)
                .accessibilityLabel(step.title)
            }
            Spacer()
        }
        .padding(20)
        .frame(width: 210, alignment: .topLeading)
    }

    @ViewBuilder
    private var currentStep: some View {
        switch model.currentStep {
        case .welcome:
            WelcomeStep(model: model)
        case .permission:
            PermissionStep(model: model)
        case .calendars:
            CalendarSelectionStep(model: model)
        case .permissionMode:
            PermissionModeStep(model: model)
        case .clientSetup:
            ClientSetupStep(model: model)
        case .verification:
            VerificationStep(model: model)
        case .complete:
            CompleteStep(model: model)
        }
    }
}

struct WelcomeStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Apple Calendar MCP")
                    .font(.largeTitle.weight(.semibold))
                Text("Safely connect AI assistants to your Apple Calendar.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 12) {
                TrustRow(text: "Works locally on your Mac")
                TrustRow(text: "Your calendar data stays on your device")
                TrustRow(text: "You control which calendars agents can access")
                TrustRow(text: "You control whether agents can modify events")
            }

            HStack {
                Button("Learn More") {
                    model.learnMore()
                }
                Spacer()
            }
        }
    }
}

struct PermissionStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Calendar Permission")
                .font(.title2.weight(.semibold))
            Text("Apple Calendar MCP needs permission to access your calendars through Apple's EventKit framework.")
            Text("It cannot access calendars until you approve permission.")
                .foregroundStyle(.secondary)

            StatusPill(
                title: model.hasCalendarPermission ? "Calendar Access Granted" : "Calendar Access Not Granted",
                systemImage: model.hasCalendarPermission ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
                color: model.hasCalendarPermission ? .green : .orange
            )

            HStack {
                Button("Request Calendar Access") {
                    model.requestPermission()
                }
                .disabled(model.isBusy || model.hasCalendarPermission)
                Button("Refresh") {
                    model.refresh()
                }
                .disabled(model.isBusy)
                Button("Open System Settings") {
                    model.openSystemSettings()
                }
            }

            if !model.hasCalendarPermission {
                RecoveryInstructions()
            }
        }
    }
}

struct CalendarSelectionStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Calendar Access Selection")
                        .font(.title2.weight(.semibold))
                    HStack {
                        Text("Manual selection")
                        Text("Recommended")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(.blue.opacity(0.14), in: Capsule())
                    }
                    Text("Only selected calendars will be visible to AI assistants. Blocked calendars remain hidden.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.selectedCalendarCountText)
                    .font(.headline)
            }

            HStack {
                Button("Select All") {
                    model.selectAllCalendars()
                }
                Button("Clear All") {
                    model.clearAllCalendars()
                }
                Button("Allow All Calendars") {
                    model.allowAllCalendars()
                }
                Spacer()
            }

            CalendarList(model: model)
        }
    }
}

struct PermissionModeStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Permission Mode")
                .font(.title2.weight(.semibold))
            Text("Choose how much control AI assistants should have.")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 10) {
                ForEach(SetupPermissionMode.allCases) { mode in
                    PermissionModeOption(
                        mode: mode,
                        isSelected: model.permissionMode == mode,
                        action: { model.setPermissionMode(mode) }
                    )
                }
            }

            if model.permissionMode == .fullWrite {
                WarningBox(text: "Full Write grants the broadest MCP write mode. Server-side safety checks, rollback, audit logging, allowlists, and required confirmations for high-risk actions still apply.")
            }
        }
    }
}

struct ClientSetupStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("MCP Client Setup")
                .font(.title2.weight(.semibold))
            Text("Choose the client you want to connect. Configuration is shown before anything is copied or installed.")
                .foregroundStyle(.secondary)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 10)], alignment: .leading, spacing: 10) {
                ForEach(SetupClient.allCases) { client in
                    ClientCard(
                        client: client,
                        isSelected: model.selectedClient == client,
                        isDetected: client.isDetected
                    ) {
                        model.selectedClient = client
                        model.installPreview = nil
                    }
                }
            }

            GroupBox(model.selectedClient.title) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(model.selectedClient.instructions)
                        .foregroundStyle(.secondary)
                    ScrollView {
                        Text(model.selectedClient.configurationSnippet)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                    }
                    .frame(minHeight: 160, maxHeight: 220)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))

                    HStack {
                        Button("Copy Configuration") {
                            model.copySelectedClientConfig()
                        }
                        if model.selectedClient.supportsAutomaticInstall {
                            Button("Preview Install into \(model.selectedClient.title)") {
                                model.previewInstallSelectedClient()
                            }
                        }
                    }

                    if let preview = model.installPreview {
                        Divider()
                        Text("Install preview")
                            .font(.headline)
                        Text("Will modify: \(preview.destinationPath)")
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        Text(preview.summary)
                            .foregroundStyle(.secondary)
                        Button("Install into \(preview.client.title)") {
                            model.installSelectedClientAfterPreview()
                        }
                    }
                }
                .padding(8)
            }
        }
    }
}

struct VerificationStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Verification")
                .font(.title2.weight(.semibold))
            Text("Check that permissions, EventKit, local state, and MCP configuration are ready.")
                .foregroundStyle(.secondary)

            HStack {
                Button("Run Test Connection") {
                    model.runTestConnection()
                }
                .disabled(model.isTestingConnection)
                Button("Refresh") {
                    model.runTestConnection()
                }
                .disabled(model.isTestingConnection)
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(model.verificationRows) { row in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: row.isPassing ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(row.isPassing ? .green : .red)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label)
                            Text(row.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .onAppear {
                model.runTestConnection()
            }
        }
    }
}

struct CompleteStep: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            StatusPill(title: "Apple Calendar MCP is ready.", systemImage: "checkmark.seal.fill", color: .green)
            SummaryRow(label: "Calendars allowed", value: "\(model.allowedCalendarIds.count)")
            SummaryRow(label: "Permission mode", value: model.permissionMode.title)
            SummaryRow(label: "Connected MCP client", value: model.connectedClientName)

            HStack {
                Button("Launch Documentation") {
                    model.launchDocumentation()
                }
                Button("Manage Settings") {
                    model.showSettings = true
                }
                Button("Done") {
                    model.done()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        TabView {
            CalendarAccessSettings(model: model)
                .tabItem { Text("Calendar Access") }
            PermissionModeSettings(model: model)
                .tabItem { Text("Permission Mode") }
            ConnectedClientsSettings(model: model)
                .tabItem { Text("Connected Clients") }
            DiagnosticsSettings(model: model)
                .tabItem { Text("Diagnostics") }
            AdvancedSettings(model: model)
                .tabItem { Text("Advanced") }
        }
        .padding(20)
    }
}

struct CalendarAccessSettings: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Calendar Access")
                .font(.title2.weight(.semibold))
            Text("Changes immediately update the local MCP configuration.")
                .foregroundStyle(.secondary)
            HStack {
                Button("Allow All") { model.allowAllCalendars() }
                Button("Select All") { model.selectAllCalendars() }
                Button("Clear All") { model.clearAllCalendars() }
                Spacer()
                Text(model.selectedCalendarCountText)
            }
            CalendarList(model: model)
        }
    }
}

struct PermissionModeSettings: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Permission Mode")
                .font(.title2.weight(.semibold))
            ForEach(SetupPermissionMode.allCases) { mode in
                PermissionModeOption(
                    mode: mode,
                    isSelected: model.permissionMode == mode,
                    action: { model.setPermissionMode(mode) }
                )
            }
            Spacer()
        }
    }
}

struct ConnectedClientsSettings: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        ClientSetupStep(model: model)
    }
}

struct DiagnosticsSettings: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Diagnostics")
                .font(.title2.weight(.semibold))
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                ForEach(model.healthRows) { row in
                    GridRow {
                        Text(row.label)
                            .foregroundStyle(.secondary)
                        Text(row.value)
                            .textSelection(.enabled)
                    }
                }
            }
            HStack {
                Button("Refresh") { model.refresh() }
                Button("Run Test Connection") { model.runTestConnection() }
                    .disabled(model.isTestingConnection)
                Button("Open System Settings") { model.openSystemSettings() }
            }
            RecoveryInstructions()
            Spacer()
        }
    }
}

struct AdvancedSettings: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Advanced")
                .font(.title2.weight(.semibold))
            SummaryRow(label: "Config file", value: model.configPath)
            SummaryRow(label: "Environment file", value: model.envPath)
            SummaryRow(label: "State database", value: SetupPaths.stateDatabase.path)
            SummaryRow(label: "Helper executable", value: SetupPaths.helperExecutable.path)
            HStack {
                Button("Generate Config") {
                    model.generateConfig()
                }
                Button("Reset") {
                    model.resetConfig()
                }
            }
            WarningBox(text: "Reset removes the local setup config and environment file. It does not modify Apple Calendar data.")
            Spacer()
        }
    }
}

struct CalendarList: View {
    @ObservedObject var model: SetupModel

    var body: some View {
        GroupBox {
            if model.calendars.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No calendars are visible yet.")
                    Text("Request Calendar access, then refresh.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(model.calendars) { calendar in
                            Toggle(isOn: Binding(
                                get: { model.allowedCalendarIds.contains(calendar.nativeCalendarId) },
                                set: { model.setAllowed(calendar, isAllowed: $0) }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(calendar.title)
                                    Text(calendar.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .toggleStyle(.checkbox)
                            .padding(.vertical, 4)
                        }
                    }
                    .padding(8)
                }
                .frame(minHeight: 220, maxHeight: 300)
            }
        }
    }
}

struct TrustRow: View {
    let text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text(text)
        }
    }
}

struct StatusPill: View {
    let title: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
            Text(title)
        }
        .font(.headline)
        .foregroundStyle(color)
        .padding(10)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct PermissionModeOption: View {
    let mode: SetupPermissionMode
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(isSelected ? .blue : .secondary)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(mode.title)
                            .font(.headline)
                        if mode == .askBeforeWrite {
                            Text("Recommended")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(.blue.opacity(0.14), in: Capsule())
                        }
                    }
                    Text(mode.description)
                        .foregroundStyle(.secondary)
                    if mode == .trustedWrite || mode == .fullWrite {
                        Text("High-risk actions still use server-side safeguards required by the security model.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(12)
            .background(isSelected ? Color.accentColor.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode.title)
    }
}

struct ClientCard: View {
    let client: SetupClient
    let isSelected: Bool
    let isDetected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: client.systemImage)
                    Spacer()
                    if isDetected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                Text(client.title)
                    .font(.headline)
                Text(isDetected ? "Detected" : "Manual setup")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isSelected ? Color.accentColor : Color.secondary.opacity(0.20), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

struct RecoveryInstructions: View {
    var body: some View {
        GroupBox("Permission Recovery") {
            VStack(alignment: .leading, spacing: 6) {
                Text("Open System Settings > Privacy & Security > Calendars and enable Apple Calendar MCP Helper.")
                Text("If the prompt does not reappear during development, run: tccutil reset Calendar")
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                Text("Then reopen this setup app and request access again.")
            }
            .foregroundStyle(.secondary)
            .padding(8)
        }
    }
}

struct WarningBox: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(text)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct SummaryRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 160, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
        }
    }
}

enum SetupStep: Int, CaseIterable, Identifiable {
    case welcome
    case permission
    case calendars
    case permissionMode
    case clientSetup
    case verification
    case complete

    var id: Int { rawValue }
    var index: Int { rawValue }

    var title: String {
        switch self {
        case .welcome:
            return "Welcome"
        case .permission:
            return "Calendar Permission"
        case .calendars:
            return "Calendar Access Selection"
        case .permissionMode:
            return "Permission Mode"
        case .clientSetup:
            return "MCP Client Setup"
        case .verification:
            return "Verification"
        case .complete:
            return "Complete"
        }
    }

    var sidebarTitle: String { title }

    var previous: SetupStep? {
        SetupStep(rawValue: rawValue - 1)
    }

    var next: SetupStep? {
        SetupStep(rawValue: rawValue + 1)
    }
}

enum SetupPermissionMode: String, CaseIterable, Identifiable {
    case readOnly = "read_only"
    case askBeforeWrite = "ask_before_write"
    case trustedWrite = "trusted_write"
    case fullWrite = "full_write"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .readOnly:
            return "Read Only"
        case .askBeforeWrite:
            return "Ask Before Write"
        case .trustedWrite:
            return "Trusted Write"
        case .fullWrite:
            return "Full Write"
        }
    }

    var description: String {
        switch self {
        case .readOnly:
            return "Can view calendars and events."
        case .askBeforeWrite:
            return "Recommended. AI assistants must receive confirmation before making changes."
        case .trustedWrite:
            return "Can create and update events without additional confirmation when server policy allows it."
        case .fullWrite:
            return "Can create, update, and delete events when server policy allows it."
        }
    }
}

enum SetupClient: String, CaseIterable, Identifiable {
    case claude
    case codex
    case cursor
    case openClaw
    case generic

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claude:
            return "Claude"
        case .codex:
            return "Codex"
        case .cursor:
            return "Cursor"
        case .openClaw:
            return "OpenClaw"
        case .generic:
            return "Generic MCP"
        }
    }

    var systemImage: String {
        switch self {
        case .claude:
            return "text.bubble"
        case .codex:
            return "terminal"
        case .cursor:
            return "cursorarrow"
        case .openClaw:
            return "shippingbox"
        case .generic:
            return "server.rack"
        }
    }

    var isDetected: Bool {
        FileManager.default.fileExists(atPath: destinationPath)
    }

    var supportsAutomaticInstall: Bool {
        self == .cursor || self == .codex
    }

    var destinationPath: String {
        switch self {
        case .claude:
            return SetupPaths.homePath("Library/Application Support/Claude/claude_desktop_config.json")
        case .codex:
            return SetupPaths.homePath(".codex/config.toml")
        case .cursor:
            return SetupPaths.homePath(".cursor/mcp.json")
        case .openClaw:
            return SetupPaths.homePath(".openclaw/openclaw.json")
        case .generic:
            return "Use your MCP client's local stdio server settings."
        }
    }

    var instructions: String {
        switch self {
        case .claude:
            return "Merge the apple-calendar entry into Claude Desktop's mcpServers object, then restart Claude Desktop."
        case .codex:
            return "Append the apple-calendar TOML section to ~/.codex/config.toml. The installer can do this after preview."
        case .cursor:
            return "Merge the apple-calendar entry into ~/.cursor/mcp.json or a project .cursor/mcp.json. The installer can update the global file after preview."
        case .openClaw:
            return "Merge the apple-calendar entry under mcp.servers, then run openclaw mcp doctor apple-calendar --probe."
        case .generic:
            return "Use the stdio command, args, and environment with any MCP client that supports local servers."
        }
    }

    var configurationSnippet: String {
        switch self {
        case .codex:
            return SetupPaths.codexConfiguration
        case .openClaw:
            return SetupPaths.openClawConfiguration
        case .claude, .cursor, .generic:
            return SetupPaths.standardMCPConfiguration
        }
    }

    var installPreview: ClientInstallPreview {
        ClientInstallPreview(
            client: self,
            destinationPath: destinationPath,
            summary: FileManager.default.fileExists(atPath: destinationPath)
                ? "Existing config will be preserved where possible and the apple-calendar server entry will be added or replaced."
                : "A new config file will be created with the apple-calendar server entry."
        )
    }

    func installConfiguration() throws {
        guard SetupPaths.nodeExecutable != nil else {
            throw SetupError.message("Node executable was not found. Install Node or add it to ~/.local/node/bin, /opt/homebrew/bin, or /usr/local/bin before installing client config.")
        }

        switch self {
        case .cursor:
            try ClientConfigInstaller.installCursor()
        case .codex:
            try ClientConfigInstaller.installCodex()
        case .claude, .openClaw, .generic:
            throw SetupError.message("Automatic installation is not available for this client.")
        }
    }
}

struct SetupCalendar: Identifiable {
    let id: String
    let nativeCalendarId: String
    let title: String
    let sourceTitle: String
    let allowsContentModifications: Bool
    let isSubscribed: Bool
    let color: String?

    init?(dictionary: [String: Any]) {
        guard let nativeCalendarId = dictionary["native_calendar_id"] as? String,
              let title = dictionary["title"] as? String else {
            return nil
        }

        self.id = nativeCalendarId
        self.nativeCalendarId = nativeCalendarId
        self.title = title
        self.sourceTitle = dictionary["source_title"] as? String ?? "Calendar"
        self.allowsContentModifications = dictionary["allows_content_modifications"] as? Bool ?? false
        self.isSubscribed = dictionary["is_subscribed"] as? Bool ?? false
        self.color = dictionary["color"] as? String
    }

    var subtitle: String {
        var parts = [sourceTitle]
        if !allowsContentModifications {
            parts.append("read-only")
        }
        if isSubscribed {
            parts.append("subscribed")
        }
        return parts.joined(separator: " · ")
    }

    var configDictionary: [String: Any] {
        ["native_calendar_id": nativeCalendarId]
    }
}

struct HealthRow: Identifiable {
    let id = UUID()
    let label: String
    let value: String
}

struct VerificationRow: Identifiable {
    let id = UUID()
    let label: String
    let isPassing: Bool
    let detail: String
    var isRequired = true
}

struct ClientInstallPreview {
    let client: SetupClient
    let destinationPath: String
    let summary: String
}

struct MCPServerPreflight {
    let startupSucceeded: Bool
    let stdoutClean: Bool
    let detail: String
    var isRequired = false
}

enum SetupError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            return message
        }
    }
}

enum SetupPaths {
    static var appSupportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("AppleCalendarMCP", isDirectory: true)
    }

    static var configFile: URL {
        appSupportDirectory.appendingPathComponent("config.json", isDirectory: false)
    }

    static var envFile: URL {
        appSupportDirectory.appendingPathComponent("mcp.env", isDirectory: false)
    }

    static var stateDatabase: URL {
        appSupportDirectory.appendingPathComponent("state.sqlite", isDirectory: false)
    }

    static var helperExecutable: URL {
        Bundle.main.bundleURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent("apple-calendar-mcp-helper", isDirectory: false)
    }

    static var repositoryRoot: URL {
        var candidate = Bundle.main.bundleURL
        let fileManager = FileManager.default

        for _ in 0..<12 {
            let serverPath = candidate
                .appendingPathComponent("packages", isDirectory: true)
                .appendingPathComponent("mcp-server", isDirectory: true)
                .appendingPathComponent("dist", isDirectory: true)
                .appendingPathComponent("index.js", isDirectory: false)
            if fileManager.fileExists(atPath: serverPath.path) {
                return candidate
            }
            candidate.deleteLastPathComponent()
        }

        return Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    static var serverEntrypoint: URL {
        repositoryRoot
            .appendingPathComponent("packages", isDirectory: true)
            .appendingPathComponent("mcp-server", isDirectory: true)
            .appendingPathComponent("dist", isDirectory: true)
            .appendingPathComponent("index.js", isDirectory: false)
    }

    static var nodeExecutable: URL? {
        let environmentPaths = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        let candidateDirectories = environmentPaths + [
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".local/node/bin", isDirectory: true)
                .path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ]

        for directory in candidateDirectories {
            let candidate = URL(fileURLWithPath: directory)
                .appendingPathComponent("node", isDirectory: false)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }

    static var nodeCommandPath: String {
        nodeExecutable?.path ?? "<NODE_EXECUTABLE_NOT_FOUND>"
    }

    static var documentationURL: URL {
        repositoryRoot.appendingPathComponent("docs", isDirectory: true)
    }

    static var isAppSupportWritable: Bool {
        do {
            try FileManager.default.createDirectory(
                at: appSupportDirectory,
                withIntermediateDirectories: true
            )
            return FileManager.default.isWritableFile(atPath: appSupportDirectory.path)
        } catch {
            return false
        }
    }

    static func mcpServerPreflight() -> MCPServerPreflight {
        guard let nodeExecutable else {
            return MCPServerPreflight(
                startupSucceeded: false,
                stdoutClean: true,
                detail: "Node executable was not found. Install Node or add it to a standard location such as ~/.local/node/bin, /opt/homebrew/bin, or /usr/local/bin."
            )
        }

        guard FileManager.default.fileExists(atPath: serverEntrypoint.path) else {
            return MCPServerPreflight(
                startupSucceeded: false,
                stdoutClean: true,
                detail: "MCP server build is missing at \(serverEntrypoint.path)"
            )
        }

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = nodeExecutable
        process.arguments = [serverEntrypoint.path]
        process.standardInput = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.environment = mcpServerEnvironment

        do {
            try process.run()

            let startupDeadline = Date().addingTimeInterval(0.35)
            while process.isRunning && Date() < startupDeadline {
                Thread.sleep(forTimeInterval: 0.025)
            }

            let startupSucceeded = process.isRunning
            if process.isRunning {
                process.terminate()
            }
            if !waitForProcessExit(process, timeout: 0.75), process.isRunning {
                Darwin.kill(process.processIdentifier, SIGKILL)
                _ = waitForProcessExit(process, timeout: 0.5)
            }

            let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrText = String(data: stderrData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let stdoutClean = startupSucceeded ? stdoutData.isEmpty : true
            let detail = startupSucceeded
                ? "MCP server started and waited for stdio input"
                : "MCP server exited early. \(stderrText.isEmpty ? "Check Node and build output." : stderrText.prefix(240))"

            return MCPServerPreflight(
                startupSucceeded: startupSucceeded,
                stdoutClean: stdoutClean,
                detail: detail
            )
        } catch {
            return MCPServerPreflight(
                startupSucceeded: false,
                stdoutClean: true,
                detail: "Could not launch MCP server with \(nodeExecutable.path): \(error.localizedDescription)"
            )
        }
    }

    private static func waitForProcessExit(_ process: Process, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.025)
        }
        return !process.isRunning
    }

    static var mcpServerEnvironment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let pathParts = [
            environment["PATH"],
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".local/node/bin", isDirectory: true)
                .path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ].compactMap { $0 }

        environment["PATH"] = pathParts.joined(separator: ":")
        environment["APPLE_CALENDAR_MCP_HELPER"] = helperExecutable.path
        environment["APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE"] = "app"
        environment["APPLE_CALENDAR_MCP_DATABASE_PATH"] = stateDatabase.path
        environment["APPLE_CALENDAR_MCP_CONFIG_PATH"] = configFile.path
        return environment
    }

    static var stdioServer: [String: Any] {
        [
            "type": "stdio",
            "command": nodeCommandPath,
            "args": [serverEntrypoint.path],
            "env": [
                "APPLE_CALENDAR_MCP_HELPER": helperExecutable.path,
                "APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE": "app",
                "APPLE_CALENDAR_MCP_DATABASE_PATH": stateDatabase.path,
                "APPLE_CALENDAR_MCP_CONFIG_PATH": configFile.path
            ]
        ]
    }

    static var standardMCPConfiguration: String {
        jsonString([
            "mcpServers": [
                "apple-calendar": stdioServer
            ]
        ])
    }

    static var openClawConfiguration: String {
        jsonString([
            "mcp": [
                "servers": [
                    "apple-calendar": stdioServer
                ]
            ]
        ])
    }

    static var codexConfiguration: String {
        """
        [mcp_servers.apple-calendar]
        command = "\(nodeCommandPath)"
        args = ["\(serverEntrypoint.path)"]

        [mcp_servers.apple-calendar.env]
        APPLE_CALENDAR_MCP_HELPER = "\(helperExecutable.path)"
        APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE = "app"
        APPLE_CALENDAR_MCP_DATABASE_PATH = "\(stateDatabase.path)"
        APPLE_CALENDAR_MCP_CONFIG_PATH = "\(configFile.path)"
        """
    }

    static func homePath(_ suffix: String) -> String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(suffix).path
    }

    static func jsonString(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}

enum SetupConfigWriter {
    static func write(calendars: [SetupCalendar], permissionMode: SetupPermissionMode) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: SetupPaths.appSupportDirectory,
            withIntermediateDirectories: true
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: SetupPaths.appSupportDirectory.path
        )

        let generatedAt = ISO8601DateFormatter().string(from: Date())
        let config: [String: Any] = [
            "version": 1,
            "generated_at": generatedAt,
            "database_path": SetupPaths.stateDatabase.path,
            "helper_executable": SetupPaths.helperExecutable.path,
            "helper_launch_mode": "app",
            "permission_mode": permissionMode.rawValue,
            "allowed_native_calendar_ids": calendars.map(\.nativeCalendarId),
            "calendar_allowlist": calendars.map(\.configDictionary)
        ]

        try writeJSONObject(config, to: SetupPaths.configFile)
        try writeEnvFile(to: SetupPaths.envFile)
    }

    private static func writeJSONObject(_ object: [String: Any], to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func writeEnvFile(to url: URL) throws {
        let content = """
        APPLE_CALENDAR_MCP_HELPER=\(shellEscaped(SetupPaths.helperExecutable.path))
        APPLE_CALENDAR_MCP_HELPER_LAUNCH_MODE=app
        APPLE_CALENDAR_MCP_DATABASE_PATH=\(shellEscaped(SetupPaths.stateDatabase.path))
        APPLE_CALENDAR_MCP_CONFIG_PATH=\(shellEscaped(SetupPaths.configFile.path))
        """
        try Data((content + "\n").utf8).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func reset() throws {
        let fileManager = FileManager.default
        for url in [SetupPaths.configFile, SetupPaths.envFile] where fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
    }

    private static func shellEscaped(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

enum ClientConfigInstaller {
    static func installCursor() throws {
        let url = URL(fileURLWithPath: SetupClient.cursor.destinationPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let existing = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = existing
        }

        var servers = root["mcpServers"] as? [String: Any] ?? [:]
        servers["apple-calendar"] = SetupPaths.stdioServer
        root["mcpServers"] = servers

        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func installCodex() throws {
        let url = URL(fileURLWithPath: SetupClient.codex.destinationPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

        let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        let cleaned = removeCodexAppleCalendarSection(from: existing)
        let separator = cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "\n\n"
        try (cleaned.trimmingCharacters(in: .newlines) + separator + SetupPaths.codexConfiguration + "\n")
            .write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func removeCodexAppleCalendarSection(from contents: String) -> String {
        let lines = contents.components(separatedBy: .newlines)
        var result: [String] = []
        var skipping = false

        for line in lines {
            if line == "[mcp_servers.apple-calendar]" || line == "[mcp_servers.apple-calendar.env]" {
                skipping = true
                continue
            }
            if skipping && line.hasPrefix("[") {
                skipping = false
            }
            if !skipping {
                result.append(line)
            }
        }

        return result.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
