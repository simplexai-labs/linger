import CoreMedia
import Foundation
import ScreenCaptureKit

// Lightweight macOS 14+ ScreenCaptureKit window-only capture watcher.
// Reads JSON-line commands from stdin:
//   {"watch": 12345}
//   {"stop": 12345}
// Emits JSON-line notifications to stdout:
//   {"stopped_by_user": 12345}
//
// Holding an SCStream with SCContentFilter(desktopIndependentWindow:) displays
// macOS's native per-window purple menu-bar indicator and delivers
// SCStreamError.userStopped (-3817) when the user clicks "Stop Sharing".

private let userStoppedCode = -3817

private func emitJSON(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else {
        return
    }
    line.append("\n")
    FileHandle.standardOutput.write(Data(line.utf8))
}

@available(macOS 14.0, *)
private final class WindowStreamDelegate: NSObject, SCStreamDelegate {
    let windowID: UInt32
    let onStopped: (UInt32, Bool) -> Void

    init(windowID: UInt32, onStopped: @escaping (UInt32, Bool) -> Void) {
        self.windowID = windowID
        self.onStopped = onStopped
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nsError = error as NSError
        let stoppedByUser = nsError.code == userStoppedCode
        onStopped(windowID, stoppedByUser)
    }
}

@available(macOS 14.0, *)
private final class WindowShareManager: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.linger.window-share")
    private var streams: [UInt32: (SCStream, WindowStreamDelegate)] = [:]

    func watch(windowID: UInt32) {
        queue.async { [weak self] in
            guard let self else { return }
            if self.streams[windowID] != nil {
                return
            }
            Task { [weak self] in
                guard let self else { return }
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(
                        false,
                        onScreenWindowsOnly: false
                    )
                    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                        return
                    }
                    let filter = SCContentFilter(desktopIndependentWindow: window)
                    let config = SCStreamConfiguration()
                    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                    config.width = 160
                    config.height = 120
                    config.showsCursor = false

                    let delegate = WindowStreamDelegate(windowID: windowID) { [weak self] id, byUser in
                        self?.handleStopped(windowID: id, byUser: byUser)
                    }
                    let stream = SCStream(filter: filter, configuration: config, delegate: delegate)
                    self.queue.sync {
                        self.streams[windowID] = (stream, delegate)
                    }
                    try await stream.startCapture()
                } catch {
                    self.queue.async {
                        self.streams.removeValue(forKey: windowID)
                    }
                }
            }
        }
    }

    func stop(windowID: UInt32) {
        queue.async { [weak self] in
            guard let self, let entry = self.streams.removeValue(forKey: windowID) else {
                return
            }
            Task {
                try? await entry.0.stopCapture()
            }
        }
    }

    func stopAll() {
        let active: [SCStream] = queue.sync {
            let values = streams.values.map(\.0)
            streams.removeAll()
            return values
        }
        let group = DispatchGroup()
        for stream in active {
            group.enter()
            Task {
                try? await stream.stopCapture()
                group.leave()
            }
        }
        _ = group.wait(timeout: .now() + .seconds(2))
    }

    private func handleStopped(windowID: UInt32, byUser: Bool) {
        queue.async { [weak self] in
            self?.streams.removeValue(forKey: windowID)
            if byUser {
                emitJSON(["stopped_by_user": windowID])
            }
        }
    }
}

if #available(macOS 14.0, *) {
    let manager = WindowShareManager()
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            continue
        }
        if let raw = object["watch"] as? NSNumber {
            manager.watch(windowID: raw.uint32Value)
        } else if let raw = object["stop"] as? NSNumber {
            manager.stop(windowID: raw.uint32Value)
        }
    }
    manager.stopAll()
} else {
    exit(0)
}
