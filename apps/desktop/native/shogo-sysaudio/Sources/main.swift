// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// shogo-sysaudio — minimal macOS system-audio capture helper.
//
// Scoped intentionally small: spawn ScreenCaptureKit with audio enabled,
// downmix/convert to Int16 PCM, and stream the bytes on stdout. Control
// events go to stderr as newline-delimited JSON. All WAV writing, mixing,
// and lifecycle management happens on the Node/Electron side.
//
// Protocol:
//   stdin:  "start\n" | "stop\n" | "quit\n"
//   stdout: raw Int16 LE interleaved PCM @ 48 kHz, 2 channels
//   stderr: { "type": "ready" | "started" | "stopped" | "error" | "warning", ... }

import Foundation
import AVFoundation
import CoreAudio
@preconcurrency import ScreenCaptureKit

// MARK: - Stderr JSON event helper

let SAMPLE_RATE: Double = 48000
let CHANNELS: Int = 2
let BITS_PER_SAMPLE: Int = 16

let stderrLock = NSLock()

func emit(_ type: String, _ data: [String: Any] = [:]) {
    var obj: [String: Any] = ["type": type]
    for (k, v) in data { obj[k] = v }
    guard let json = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: json, encoding: .utf8) else { return }
    line.append("\n")
    stderrLock.lock()
    if let bytes = line.data(using: .utf8) {
        FileHandle.standardError.write(bytes)
    }
    stderrLock.unlock()
}

// MARK: - Stdout PCM writer

let stdoutLock = NSLock()
let stdoutHandle = FileHandle.standardOutput
var framesWritten: UInt64 = 0

func writePCM(_ data: Data) {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    stdoutHandle.write(data)
    framesWritten += UInt64(data.count / (CHANNELS * BITS_PER_SAMPLE / 8))
}

// MARK: - SCStream audio delegate

final class AudioDelegate: NSObject, SCStreamOutput, SCStreamDelegate {
    private var reportedFormat = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }

        guard let formatDesc = sampleBuffer.formatDescription,
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }

        var asbd = asbdPtr.pointee
        if !reportedFormat {
            reportedFormat = true
            emit("source_format", [
                "sampleRate": asbd.mSampleRate,
                "channels": Int(asbd.mChannelsPerFrame),
                "formatFlags": Int(asbd.mFormatFlags),
                "bitsPerChannel": Int(asbd.mBitsPerChannel),
            ])
        }

        guard let srcFormat = AVAudioFormat(streamDescription: &asbd) else { return }
        let frameCount = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frameCount > 0 else { return }

        // Use the standard float32 format (deinterleaved planar) for the
        // intermediate buffer — ScreenCaptureKit hands us either deinterleaved
        // float32 natively (common case) or something AVAudioConverter can
        // coerce into it.
        guard let floatFormat = AVAudioFormat(standardFormatWithSampleRate: srcFormat.sampleRate,
                                              channels: srcFormat.channelCount),
              let floatBuf = AVAudioPCMBuffer(pcmFormat: floatFormat, frameCapacity: frameCount) else {
            return
        }
        floatBuf.frameLength = frameCount

        if !copySampleBufferToFloat(sampleBuffer: sampleBuffer, srcFormat: srcFormat, dest: floatBuf) {
            emit("warning", ["message": "failed to read PCM from sample buffer"])
            return
        }

        // Always produce 48 kHz / 2-channel / Int16 LE on stdout so the Node
        // side can treat the stream as a fixed-format WAV payload.
        guard let output = convertToInt16Stereo48k(source: floatBuf) else { return }
        writePCM(output)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit("error", ["message": "stream stopped: \(error.localizedDescription)"])
    }
}

/// Copy either interleaved-or-planar Int16/Float32 sample data from a
/// CMSampleBuffer into a deinterleaved Float32 AVAudioPCMBuffer.
private func copySampleBufferToFloat(sampleBuffer: CMSampleBuffer,
                                     srcFormat: AVAudioFormat,
                                     dest: AVAudioPCMBuffer) -> Bool {
    guard let floatData = dest.floatChannelData,
          let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return false }

    let channelCount = Int(srcFormat.channelCount)
    let frameCount = Int(dest.frameLength)

    var totalLength = 0
    var dataPtr: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                      totalLengthOut: &totalLength, dataPointerOut: &dataPtr) == noErr,
          let base = dataPtr else { return false }

    switch srcFormat.commonFormat {
    case .pcmFormatFloat32:
        let src = UnsafeRawPointer(base).assumingMemoryBound(to: Float.self)
        if srcFormat.isInterleaved {
            for f in 0..<frameCount {
                for c in 0..<channelCount {
                    floatData[c][f] = src[f * channelCount + c]
                }
            }
        } else {
            for c in 0..<channelCount {
                let channelBase = src.advanced(by: c * frameCount)
                memcpy(floatData[c], channelBase, frameCount * MemoryLayout<Float>.size)
            }
        }
        return true

    case .pcmFormatInt16:
        let src = UnsafeRawPointer(base).assumingMemoryBound(to: Int16.self)
        if srcFormat.isInterleaved {
            for f in 0..<frameCount {
                for c in 0..<channelCount {
                    floatData[c][f] = Float(src[f * channelCount + c]) / 32768.0
                }
            }
        } else {
            for c in 0..<channelCount {
                for f in 0..<frameCount {
                    floatData[c][f] = Float(src[c * frameCount + f]) / 32768.0
                }
            }
        }
        return true

    default:
        return false
    }
}

/// Convert a deinterleaved Float32 AVAudioPCMBuffer at any sample rate and
/// channel layout into 48 kHz, interleaved stereo Int16 LE suitable for a
/// 48000/2/16 WAV stream.
private func convertToInt16Stereo48k(source: AVAudioPCMBuffer) -> Data? {
    let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: SAMPLE_RATE,
        channels: AVAudioChannelCount(CHANNELS),
        interleaved: true
    )!

    guard let converter = AVAudioConverter(from: source.format, to: targetFormat) else {
        return nil
    }
    // Produce stereo even from multi-channel (5.1 etc) sources so the output
    // stream format is predictable downstream.
    converter.downmix = source.format.channelCount > 2

    let ratio = targetFormat.sampleRate / source.format.sampleRate
    let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio + 32)
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
        return nil
    }

    var consumed = false
    var err: NSError?
    converter.convert(to: outBuf, error: &err) { _, outStatus in
        if consumed {
            outStatus.pointee = .noDataNow
            return nil
        }
        consumed = true
        outStatus.pointee = .haveData
        return source
    }
    if let err = err {
        emit("warning", ["message": "converter error: \(err.localizedDescription)"])
        return nil
    }

    let frames = Int(outBuf.frameLength)
    guard frames > 0, let int16Ptr = outBuf.int16ChannelData?.pointee else { return nil }
    let byteCount = frames * CHANNELS * MemoryLayout<Int16>.size
    return Data(bytes: int16Ptr, count: byteCount)
}

// MARK: - Capture lifecycle

actor Capturer {
    private var stream: SCStream?
    private var delegate: AudioDelegate?
    private var active = false

    func start() async throws {
        if active { return }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "shogo-sysaudio", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no display available for ScreenCaptureKit"])
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(SAMPLE_RATE)
        config.channelCount = CHANNELS
        // We don't need video; keep the overhead as low as SCK will let us.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let del = AudioDelegate()
        let scStream = SCStream(filter: filter, configuration: config, delegate: del)
        try scStream.addStreamOutput(del, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))

        try await scStream.startCapture()

        self.delegate = del
        self.stream = scStream
        self.active = true
        framesWritten = 0
        emit("started", [
            "sampleRate": Int(SAMPLE_RATE),
            "channels": CHANNELS,
            "bitsPerSample": BITS_PER_SAMPLE,
        ])
    }

    func stop() async {
        guard active else { return }
        active = false
        if let s = stream {
            try? await s.stopCapture()
        }
        stream = nil
        delegate = nil
        emit("stopped", ["frames": NSNumber(value: framesWritten)])
    }
}

// MARK: - stdin command loop

let capturer = Capturer()
let cmdQueue = DispatchQueue(label: "shogo-sysaudio.stdin")

func runStdinLoop() {
    cmdQueue.async {
        let stdin = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = stdin.availableData
            if chunk.isEmpty {
                // stdin closed — shut down cleanly
                Task {
                    await capturer.stop()
                    exit(0)
                }
                return
            }
            buffer.append(chunk)
            while let nlIdx = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                let lineData = buffer.prefix(upTo: nlIdx)
                buffer.removeSubrange(...nlIdx)
                guard let raw = String(data: lineData, encoding: .utf8) else { continue }
                let cmd = raw.trimmingCharacters(in: .whitespaces)
                handleCommand(cmd)
            }
        }
    }
}

func handleCommand(_ cmd: String) {
    switch cmd {
    case "start":
        Task {
            do {
                try await capturer.start()
            } catch {
                emit("error", ["message": "start failed: \(error.localizedDescription)"])
            }
        }
    case "stop":
        Task {
            await capturer.stop()
        }
    case "quit", "exit":
        Task {
            await capturer.stop()
            exit(0)
        }
    case "":
        break
    default:
        emit("warning", ["message": "unknown command: \(cmd)"])
    }
}

// MARK: - Main

emit("ready")
runStdinLoop()

// Dispatch the run loop forever; Tasks are scheduled on the global executor.
RunLoop.main.run()
