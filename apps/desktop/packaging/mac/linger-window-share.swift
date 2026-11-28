import AppKit
import CoreGraphics
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
private final class WindowStreamDelegate: NSObject, SCStreamDelegate, SCStreamOutput {
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

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        // No-op consumer prevents ScreenCaptureKit dropped-frame warnings while
        // keeping the per-window menu-bar sharing indicator alive.
    }
}

@available(macOS 14.0, *)
private final class WindowShareManager: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.linger.window-share")
    private let sampleQueue = DispatchQueue(label: "com.linger.window-share.samples", qos: .utility)
    private var currentWindowID: UInt32?
    private var activeStream: (SCStream, WindowStreamDelegate)?

    func watch(windowID: UInt32) {
        queue.async { [weak self] in
            guard let self else { return }
            if self.currentWindowID == windowID {
                return
            }
            let previous = self.activeStream
            self.activeStream = nil
            self.currentWindowID = windowID

            Task { [weak self] in
                if let previous {
                    try? await previous.0.stopCapture()
                }
                guard let self else { return }
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(
                        false,
                        onScreenWindowsOnly: false
                    )
                    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                        self.clearIfCurrent(windowID: windowID)
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
                    try stream.addStreamOutput(delegate, type: .screen, sampleHandlerQueue: self.sampleQueue)

                    let shouldStart: Bool = self.queue.sync {
                        guard self.currentWindowID == windowID else {
                            return false
                        }
                        self.activeStream = (stream, delegate)
                        return true
                    }
                    guard shouldStart else {
                        return
                    }
                    try await stream.startCapture()
                } catch {
                    self.clearIfCurrent(windowID: windowID)
                }
            }
        }
    }

    func stop(windowID: UInt32) {
        queue.async { [weak self] in
            guard let self, self.currentWindowID == windowID else {
                return
            }
            let previous = self.activeStream
            self.activeStream = nil
            self.currentWindowID = nil
            if let previous {
                Task {
                    try? await previous.0.stopCapture()
                }
            }
        }
    }

    func stopAll() {
        let previous: SCStream? = queue.sync {
            let stream = activeStream?.0
            activeStream = nil
            currentWindowID = nil
            return stream
        }
        guard let previous else { return }
        let group = DispatchGroup()
        group.enter()
        Task {
            try? await previous.stopCapture()
            group.leave()
        }
        _ = group.wait(timeout: .now() + .seconds(2))
    }

    private func clearIfCurrent(windowID: UInt32) {
        queue.async { [weak self] in
            guard let self, self.currentWindowID == windowID else { return }
            self.activeStream = nil
            self.currentWindowID = nil
        }
    }

    private func handleStopped(windowID: UInt32, byUser: Bool) {
        queue.async { [weak self] in
            if self?.currentWindowID == windowID {
                self?.activeStream = nil
                self?.currentWindowID = nil
            }
            if byUser {
                emitJSON(["stopped_by_user": windowID])
            }
        }
    }
}

if #available(macOS 14.0, *) {
    // Initialize the CoreGraphics / AppKit WindowServer connection on the main
    // thread before ScreenCaptureKit touches CGS (prevents CGS_REQUIRE_INIT
    // SIGABRT) while keeping the helper hidden from the Dock.
    _ = CGMainDisplayID()
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)

    let manager = WindowShareManager()
    DispatchQueue.global(qos: .userInitiated).async {
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
        DispatchQueue.main.async {
            app.terminate(nil)
        }
    }
    app.run()
} else {
    exit(0)
}
