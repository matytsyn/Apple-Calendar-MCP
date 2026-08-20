import Foundation

final class JSONLineBridge {
    private let bridge: EventKitBridge

    init(bridge: EventKitBridge) {
        self.bridge = bridge
    }

    func run() {
        while let line = readLine() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                continue
            }

            write(handleLine(trimmed), to: FileHandle.standardOutput)
        }
    }

    func run(input: FileHandle, output: FileHandle) {
        var buffer = ""

        while true {
            let data = input.availableData
            if data.isEmpty {
                return
            }

            guard let chunk = String(data: data, encoding: .utf8) else {
                continue
            }

            buffer += chunk

            while let newlineIndex = buffer.firstIndex(of: "\n") {
                let line = String(buffer[..<newlineIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
                buffer = String(buffer[buffer.index(after: newlineIndex)...])

                if !line.isEmpty {
                    write(handleLine(line), to: output)
                }
            }
        }
    }

    private func handleLine(_ line: String) -> [String: Any] {
        do {
            guard let data = line.data(using: .utf8),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw BridgeError(
                    code: "INVALID_INPUT",
                    message: "Bridge request must be a JSON object.",
                    suggestedAction: "Send one JSON object per line."
                )
            }

            let id = object["id"] ?? NSNull()
            guard let method = object["method"] as? String else {
                throw BridgeError(
                    code: "INVALID_INPUT",
                    message: "Bridge request is missing method.",
                    suggestedAction: "Provide a method string."
                )
            }

            let params = object["params"] as? [String: Any] ?? [:]
            let responseData = try bridge.handle(method: method, params: params)

            return [
                "id": id,
                "success": true,
                "data": responseData
            ]
        } catch let error as BridgeError {
            return [
                "id": extractId(from: line),
                "success": false,
                "error": error.toJSON()
            ]
        } catch {
            return [
                "id": extractId(from: line),
                "success": false,
                "error": BridgeError.fromNative(error).toJSON()
            ]
        }
    }

    private func extractId(from line: String) -> Any {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return NSNull()
        }

        return object["id"] ?? NSNull()
    }

    private func write(_ object: [String: Any], to output: FileHandle) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let line = String(data: data, encoding: .utf8) else {
            return
        }

        output.write(Data((line + "\n").utf8))
    }
}
