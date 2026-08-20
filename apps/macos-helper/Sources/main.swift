import AppKit
import Darwin
import Foundation

if CommandLine.arguments.contains("--request-permission-and-exit") {
    let delegate = PermissionPromptAppDelegate(outputPath: argumentValue(after: "--permission-output"))
    let application = NSApplication.shared
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.activate(ignoringOtherApps: true)
    application.run()
} else if let socketPath = argumentValue(after: "--bridge-socket") {
    let delegate = SocketBridgeAppDelegate(socketPath: socketPath)
    let application = NSApplication.shared
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    application.run()
} else if CommandLine.arguments.contains("--setup") || runningInsideAppBundle() {
    let delegate = SetupAppDelegate()
    let application = NSApplication.shared
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.activate(ignoringOtherApps: true)
    application.run()
} else {
    prepareStdioApplicationRuntime()
    let bridge = EventKitBridge(processMode: "direct_stdio")
    let runner = JSONLineBridge(bridge: bridge)
    runner.run()
}

private func argumentValue(after flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag) else {
        return nil
    }

    let valueIndex = CommandLine.arguments.index(after: index)
    guard valueIndex < CommandLine.arguments.endIndex else {
        return nil
    }

    return CommandLine.arguments[valueIndex]
}

private func prepareStdioApplicationRuntime() {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
}

private func runningInsideAppBundle() -> Bool {
    Bundle.main.bundleURL.pathExtension == "app"
}

private final class PermissionPromptAppDelegate: NSObject, NSApplicationDelegate {
    private let outputPath: String?
    private let bridge = EventKitBridge(processMode: "app_permission_prompt")

    init(outputPath: String?) {
        self.outputPath = outputPath
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            self.requestPermission()
            NSApplication.shared.terminate(nil)
        }
    }

    private func requestPermission() {
        let response: [String: Any]

        do {
            response = [
                "success": true,
                "data": try bridge.handle(method: "request_permission", params: [:])
            ]
        } catch let error as BridgeError {
            response = [
                "success": false,
                "error": error.toJSON()
            ]
        } catch {
            response = [
                "success": false,
                "error": BridgeError.fromNative(error).toJSON()
            ]
        }

        write(response)
    }

    private func write(_ response: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(response),
              let data = try? JSONSerialization.data(withJSONObject: response),
              let line = String(data: data, encoding: .utf8) else {
            return
        }

        if let outputPath {
            try? Data((line + "\n").utf8).write(to: URL(fileURLWithPath: outputPath), options: [.atomic])
        } else {
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }
    }
}

private final class SocketBridgeAppDelegate: NSObject, NSApplicationDelegate {
    private let socketPath: String

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.global(qos: .userInitiated).async {
            self.runBridge()
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }

    private func runBridge() {
        let serverDescriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverDescriptor >= 0 else {
            writeStderr("Unable to create bridge socket.")
            return
        }

        defer {
            Darwin.close(serverDescriptor)
            Darwin.unlink(socketPath)
        }

        Darwin.unlink(socketPath)

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)

        let encodedPath = Array(socketPath.utf8)
        guard encodedPath.count < MemoryLayout.size(ofValue: address.sun_path) else {
            writeStderr("Bridge socket path is too long.")
            return
        }

        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            for (index, byte) in encodedPath.enumerated() {
                buffer[index] = byte
            }
            buffer[encodedPath.count] = 0
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(
                    serverDescriptor,
                    sockaddrPointer,
                    socklen_t(MemoryLayout<sockaddr_un>.size)
                )
            }
        }

        guard bindResult == 0 else {
            writeStderr("Unable to bind bridge socket.")
            return
        }

        guard Darwin.listen(serverDescriptor, 1) == 0 else {
            writeStderr("Unable to listen on bridge socket.")
            return
        }

        let clientDescriptor = Darwin.accept(serverDescriptor, nil, nil)
        guard clientDescriptor >= 0 else {
            writeStderr("Unable to accept bridge socket client.")
            return
        }

        let handle = FileHandle(fileDescriptor: clientDescriptor, closeOnDealloc: true)
        let bridge = EventKitBridge(processMode: "app_socket")
        JSONLineBridge(bridge: bridge).run(input: handle, output: handle)
    }

    private func writeStderr(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
