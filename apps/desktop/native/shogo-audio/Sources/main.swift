// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import Foundation
@preconcurrency import ScreenCaptureKit
@preconcurrency import AVFoundation
import CoreAudio
import AudioToolbox
import EventKit

// MARK: - JSON Line Protocol

struct JSONEvent: Encodable {
    let type: String
    let data: [String: AnyCodable]
}

struct AnyCodable: Encodable {
    let value: Any
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as String: try container.encode(v)
        case let v as Int: try container.encode(v)
        case let v as Double: try container.encode(v)
        case let v as Bool: try container.encode(v)
        default: try container.encode(String(describing: value))
        }
    }
}

func emit(_ type: String, _ data: [String: Any] = [:]) {
    let event = JSONEvent(type: type, data: data.mapValues { AnyCodable(value: $0) })
    if let json = try? JSONEncoder().encode(event),
       let str = String(data: json, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((str + "\n").utf8))
    }
}

// MARK: - WAV Writer

class WAVWriter {
    private let fileHandle: FileHandle
    private let filePath: String
    private var dataSize: UInt32 = 0
    private let sampleRate: UInt32
    private let channels: UInt16
    private let bitsPerSample: UInt16 = 16
    private var writeCount: Int = 0

    init(path: String, sampleRate: UInt32 = 48000, channels: UInt16 = 1) throws {
        self.filePath = path
        self.sampleRate = sampleRate
        self.channels = channels
        FileManager.default.createFile(atPath: path, contents: nil)
        self.fileHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        writeHeader()
    }

    private func writeHeader() {
        var header = Data()
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)

        header.append(contentsOf: "RIFF".utf8)
        header.append(withUnsafeBytes(of: UInt32(0).littleEndian) { Data($0) })
        header.append(contentsOf: "WAVE".utf8)
        header.append(contentsOf: "fmt ".utf8)
        header.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) })
        header.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) }) // PCM
        header.append(withUnsafeBytes(of: channels.littleEndian) { Data($0) })
        header.append(withUnsafeBytes(of: sampleRate.littleEndian) { Data($0) })
        header.append(withUnsafeBytes(of: byteRate.littleEndian) { Data($0) })
        header.append(withUnsafeBytes(of: blockAlign.littleEndian) { Data($0) })
        header.append(withUnsafeBytes(of: bitsPerSample.littleEndian) { Data($0) })
        header.append(contentsOf: "data".utf8)
        header.append(withUnsafeBytes(of: UInt32(0).littleEndian) { Data($0) })

        fileHandle.write(header)
    }

    func write(pcmBuffer: AVAudioPCMBuffer) {
        guard let floatData = pcmBuffer.floatChannelData else { return }
        let frameCount = Int(pcmBuffer.frameLength)
        let channelCount = Int(pcmBuffer.format.channelCount)
        var interleavedData = Data(capacity: frameCount * Int(channels) * 2)

        for frame in 0..<frameCount {
            var mixed: Float = 0
            for ch in 0..<min(channelCount, Int(channels)) {
                mixed += floatData[ch][frame]
            }
            if channelCount > 1 && channels == 1 {
                mixed /= Float(channelCount)
            }
            let clamped = max(-1.0, min(1.0, mixed))
            var sample = Int16(clamped * Float(Int16.max))
            withUnsafeBytes(of: &sample) { interleavedData.append(contentsOf: $0) }
        }

        fileHandle.write(interleavedData)
        dataSize += UInt32(interleavedData.count)
        writeCount += 1
    }

    func finalize() {
        let fileSize = UInt32(dataSize + 36)
        fileHandle.seek(toFileOffset: 4)
        fileHandle.write(withUnsafeBytes(of: fileSize.littleEndian) { Data($0) })
        fileHandle.seek(toFileOffset: 40)
        fileHandle.write(withUnsafeBytes(of: dataSize.littleEndian) { Data($0) })
        fileHandle.closeFile()

        let durationSec = Double(dataSize) / Double(sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8))
        emit("wav_finalized", [
            "path": filePath,
            "dataBytes": Int(dataSize),
            "writeCount": writeCount,
            "durationSeconds": durationSec,
        ])
    }
}

// MARK: - Audio Recorder

class AudioRecorder {
    private var systemStream: SCStream?
    private var micEngine: AVAudioEngine?
    private var wavWriter: WAVWriter?
    private var isRecording = false
    private let outputPath: String
    private let sampleRate: Double = 48000
    private let mixQueue = DispatchQueue(label: "ai.shogo.audio.mix")
    private var startTime: Date?

    init(outputPath: String) {
        self.outputPath = outputPath
    }

    func start() async throws {
        guard !isRecording else { return }

        wavWriter = try WAVWriter(path: outputPath, sampleRate: UInt32(sampleRate), channels: 1)
        isRecording = true
        startTime = Date()

        // System audio (ScreenCaptureKit) is optional — requires Screen Recording permission
        do {
            try await startSystemAudioCapture()
        } catch {
            emit("warning", ["message": "System audio capture unavailable: \(error.localizedDescription). Recording mic only."])
        }

        try startMicCapture()

        emit("recording_started", ["path": outputPath])
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false

        systemStream?.stopCapture { _ in }
        systemStream = nil

        micEngine?.stop()
        micEngine?.inputNode.removeTap(onBus: 0)
        micEngine = nil

        mixQueue.sync {
            self.wavWriter?.finalize()
            self.wavWriter = nil
        }

        let duration = startTime.map { Int(Date().timeIntervalSince($0)) } ?? 0
        emit("recording_stopped", ["path": outputPath, "duration": duration])
    }

    private func startSystemAudioCapture() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw NSError(domain: "shogo-audio", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(sampleRate)
        config.channelCount = 1

        // We only want audio, minimize video overhead
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let delegate = SystemAudioDelegate { [weak self] buffer in
            self?.mixQueue.async { self?.wavWriter?.write(pcmBuffer: buffer) }
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(delegate, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))
        try await stream.startCapture()
        self.systemStream = stream

        // Keep delegate alive
        objc_setAssociatedObject(stream, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
    }

    private func startMicCapture() throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        emit("mic_info", [
            "sampleRate": inputFormat.sampleRate,
            "channels": Int(inputFormat.channelCount),
            "format": String(describing: inputFormat.commonFormat.rawValue),
        ])

        guard inputFormat.sampleRate > 0 && inputFormat.channelCount > 0 else {
            throw NSError(domain: "shogo-audio", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "No mic input available (sampleRate=\(inputFormat.sampleRate), channels=\(inputFormat.channelCount))"])
        }

        let targetFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw NSError(domain: "shogo-audio", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot create audio converter from \(inputFormat) to \(targetFormat)"])
        }

        var tapBufferCount = 0
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self, self.isRecording else { return }

            let frameCapacity = AVAudioFrameCount(
                Double(buffer.frameLength) * self.sampleRate / inputFormat.sampleRate
            )
            guard frameCapacity > 0,
                  let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCapacity) else { return }

            var error: NSError?
            converter.convert(to: converted, error: &error) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }

            if let error = error {
                if tapBufferCount == 0 {
                    emit("warning", ["message": "Mic converter error: \(error.localizedDescription)"])
                }
            } else {
                self.mixQueue.async { self.wavWriter?.write(pcmBuffer: converted) }
            }
            tapBufferCount += 1
        }

        engine.prepare()
        try engine.start()
        self.micEngine = engine
    }
}

// MARK: - SCStream Audio Delegate

class SystemAudioDelegate: NSObject, SCStreamOutput {
    let handler: (AVAudioPCMBuffer) -> Void
    private var bufferCount = 0

    init(handler: @escaping (AVAudioPCMBuffer) -> Void) {
        self.handler = handler
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }

        guard let formatDesc = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }

        var streamDesc = asbd.pointee

        if bufferCount == 0 {
            emit("system_audio_info", [
                "sampleRate": asbd.pointee.mSampleRate,
                "channels": Int(asbd.pointee.mChannelsPerFrame),
                "bitsPerChannel": Int(asbd.pointee.mBitsPerChannel),
                "formatFlags": Int(asbd.pointee.mFormatFlags),
            ])
        }

        guard let format = AVAudioFormat(streamDescription: &streamDesc) else { return }
        guard let buffer = sampleBuffer.toPCMBuffer(format: format) else {
            if bufferCount == 0 {
                emit("warning", ["message": "Failed to convert system audio buffer (format: \(format.commonFormat.rawValue))"])
            }
            return
        }

        handler(buffer)
        bufferCount += 1
    }
}

extension CMSampleBuffer {
    func toPCMBuffer(format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frameCount = AVAudioFrameCount(numSamples)
        guard frameCount > 0 else { return nil }

        // Always convert to float32 for WAVWriter compatibility
        let floatFormat = AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: format.channelCount)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: frameCount) else { return nil }
        buffer.frameLength = frameCount

        guard let blockBuffer = CMSampleBufferGetDataBuffer(self) else { return nil }
        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                          totalLengthOut: &length, dataPointerOut: &dataPointer) == noErr,
              let data = dataPointer else { return nil }

        guard let floatData = buffer.floatChannelData else { return nil }
        let channelCount = Int(format.channelCount)
        let srcPtr = UnsafeRawPointer(data)

        switch format.commonFormat {
        case .pcmFormatFloat32:
            let floatSrc = srcPtr.assumingMemoryBound(to: Float.self)
            if format.isInterleaved || channelCount == 1 {
                for frame in 0..<Int(frameCount) {
                    for ch in 0..<channelCount {
                        floatData[ch][frame] = floatSrc[frame * channelCount + ch]
                    }
                }
            } else {
                for ch in 0..<channelCount {
                    memcpy(floatData[ch], floatSrc.advanced(by: ch * Int(frameCount)),
                           Int(frameCount) * MemoryLayout<Float>.size)
                }
            }

        case .pcmFormatInt16:
            let int16Src = srcPtr.assumingMemoryBound(to: Int16.self)
            let scale: Float = 1.0 / Float(Int16.max)
            if format.isInterleaved || channelCount == 1 {
                for frame in 0..<Int(frameCount) {
                    for ch in 0..<channelCount {
                        floatData[ch][frame] = Float(int16Src[frame * channelCount + ch]) * scale
                    }
                }
            } else {
                for ch in 0..<channelCount {
                    for frame in 0..<Int(frameCount) {
                        floatData[ch][frame] = Float(int16Src[ch * Int(frameCount) + frame]) * scale
                    }
                }
            }

        case .pcmFormatInt32:
            let int32Src = srcPtr.assumingMemoryBound(to: Int32.self)
            let scale: Float = 1.0 / Float(Int32.max)
            if format.isInterleaved || channelCount == 1 {
                for frame in 0..<Int(frameCount) {
                    for ch in 0..<channelCount {
                        floatData[ch][frame] = Float(int32Src[frame * channelCount + ch]) * scale
                    }
                }
            } else {
                for ch in 0..<channelCount {
                    for frame in 0..<Int(frameCount) {
                        floatData[ch][frame] = Float(int32Src[ch * Int(frameCount) + frame]) * scale
                    }
                }
            }

        case .pcmFormatFloat64:
            let float64Src = srcPtr.assumingMemoryBound(to: Double.self)
            if format.isInterleaved || channelCount == 1 {
                for frame in 0..<Int(frameCount) {
                    for ch in 0..<channelCount {
                        floatData[ch][frame] = Float(float64Src[frame * channelCount + ch])
                    }
                }
            } else {
                for ch in 0..<channelCount {
                    for frame in 0..<Int(frameCount) {
                        floatData[ch][frame] = Float(float64Src[ch * Int(frameCount) + frame])
                    }
                }
            }

        default:
            return nil
        }

        return buffer
    }
}

// MARK: - Mic Monitor (Meeting Detection)

class MicMonitor {
    private var propertyAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    private var deviceID: AudioDeviceID = 0
    private var isActive = false
    private var activeSince: Date?
    private let gracePeriod: TimeInterval
    private var graceTimer: DispatchSourceTimer?
    private let onMeetingDetected: () -> Void

    init(gracePeriodSeconds: Double = 10, onMeetingDetected: @escaping () -> Void) {
        self.gracePeriod = gracePeriodSeconds
        self.onMeetingDetected = onMeetingDetected
    }

    func start() {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)

        guard deviceID != 0 else {
            emit("error", ["message": "No input device found"])
            return
        }

        let status = AudioObjectAddPropertyListenerBlock(deviceID, &propertyAddress, .main) { [weak self] _, _ in
            self?.handleMicStateChange()
        }

        if status == noErr {
            emit("monitor_started", ["deviceId": Int(deviceID)])
        } else {
            emit("error", ["message": "Failed to add mic listener: \(status)"])
        }
    }

    func stop() {
        graceTimer?.cancel()
        graceTimer = nil
        AudioObjectRemovePropertyListenerBlock(deviceID, &propertyAddress, .main) { _, _ in }
    }

    private func handleMicStateChange() {
        var isRunning: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var addr = propertyAddress
        AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &isRunning)

        let nowActive = isRunning != 0

        if nowActive && !isActive {
            isActive = true
            activeSince = Date()
            emit("mic_activated", [:])

            graceTimer?.cancel()
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + gracePeriod)
            timer.setEventHandler { [weak self] in
                guard let self = self, self.isActive else { return }
                emit("meeting_detected", ["activeSince": self.activeSince?.timeIntervalSince1970 ?? 0])
                self.onMeetingDetected()
            }
            timer.resume()
            graceTimer = timer
        } else if !nowActive && isActive {
            isActive = false
            activeSince = nil
            graceTimer?.cancel()
            graceTimer = nil
            emit("mic_deactivated", [:])
        }
    }
}

// MARK: - Calendar Monitor

class CalendarMonitor {
    private let store = EKEventStore()
    private var timer: DispatchSourceTimer?

    func start() {
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { [weak self] granted, error in
                if granted {
                    emit("calendar_access_granted", [:])
                    self?.checkUpcoming()
                    self?.schedulePolling()
                } else {
                    emit("calendar_access_denied", ["error": error?.localizedDescription ?? "unknown"])
                }
            }
        } else {
            store.requestAccess(to: .event) { [weak self] granted, error in
                if granted {
                    emit("calendar_access_granted", [:])
                    self?.checkUpcoming()
                    self?.schedulePolling()
                } else {
                    emit("calendar_access_denied", ["error": error?.localizedDescription ?? "unknown"])
                }
            }
        }
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func checkUpcoming() {
        let now = Date()
        let soon = now.addingTimeInterval(5 * 60)
        let predicate = store.predicateForEvents(withStart: now, end: soon, calendars: nil)
        let events = store.events(matching: predicate)

        let meetingEvents = events.compactMap { event -> [String: Any]? in
            let allText = [event.title, event.location, event.notes, event.url?.absoluteString]
                .compactMap { $0 }.joined(separator: " ")
            let hasMeetingUrl = allText.contains("zoom.us") || allText.contains("meet.google.com")
                || allText.contains("teams.microsoft.com") || allText.contains("webex.com")

            guard hasMeetingUrl else { return nil }
            return [
                "title": event.title ?? "Untitled",
                "start": event.startDate.timeIntervalSince1970,
                "minutesUntilStart": max(0, event.startDate.timeIntervalSince(now) / 60),
            ]
        }

        if !meetingEvents.isEmpty {
            for event in meetingEvents {
                emit("upcoming_meeting", event)
            }
        }
    }

    private func schedulePolling() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 300, repeating: 300)
        t.setEventHandler { [weak self] in self?.checkUpcoming() }
        t.resume()
        timer = t
    }
}

// MARK: - Command Handling

var recorder: AudioRecorder?
var micMonitor: MicMonitor?
var calendarMonitor: CalendarMonitor?
var shouldExit = false

func handleCommand(_ line: String) async {
    let parts = line.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ", maxSplits: 1)
    guard let command = parts.first else { return }

    switch String(command) {
    case "record":
        guard parts.count > 1 else {
            emit("error", ["message": "Usage: record <output-path>"])
            return
        }
        let path = String(parts[1])
        recorder = AudioRecorder(outputPath: path)
        do {
            try await recorder!.start()
        } catch {
            emit("error", ["message": "Failed to start recording: \(error.localizedDescription)"])
        }

    case "stop":
        recorder?.stop()
        recorder = nil

    case "monitor":
        let gracePeriod = parts.count > 1 ? Double(parts[1]) ?? 10 : 10
        micMonitor = MicMonitor(gracePeriodSeconds: gracePeriod) {
            // Meeting detected callback — parent process decides what to do
        }
        micMonitor!.start()
        calendarMonitor = CalendarMonitor()
        calendarMonitor!.start()

    case "stop-monitor":
        micMonitor?.stop()
        micMonitor = nil
        calendarMonitor?.stop()
        calendarMonitor = nil

    case "status":
        emit("status", ["recording": recorder != nil])

    case "quit":
        recorder?.stop()
        micMonitor?.stop()
        calendarMonitor?.stop()
        shouldExit = true

    default:
        emit("error", ["message": "Unknown command: \(command)"])
    }
}

// MARK: - Entry Point

signal(SIGTERM) { _ in
    recorder?.stop()
    micMonitor?.stop()
    calendarMonitor?.stop()
    emit("shutdown", [:])
    exit(0)
}

signal(SIGINT) { _ in
    recorder?.stop()
    micMonitor?.stop()
    calendarMonitor?.stop()
    emit("shutdown", [:])
    exit(0)
}

emit("ready", [:])

// Read commands from stdin, line by line
Task {
    let handle = FileHandle.standardInput
    while !shouldExit {
        guard let data = try? handle.availableData, !data.isEmpty else {
            try? await Task.sleep(nanoseconds: 100_000_000)
            continue
        }
        if let line = String(data: data, encoding: .utf8) {
            for cmd in line.split(separator: "\n") {
                await handleCommand(String(cmd))
            }
        }
    }
    exit(0)
}

RunLoop.main.run()
