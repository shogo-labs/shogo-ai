// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// shogo-hotkey: global hold-to-talk key detection for Shogo Desktop (macOS).
//
// Electron's globalShortcut cannot see the Fn key or key *release*, which
// push-to-talk needs. This helper runs a CGEventTap and reports when a
// configured chord (e.g. `fn`, or `control+option+space`) is pressed and
// released. It can also synthesize Cmd+V so dictated text can be pasted into
// whichever app has focus.
//
// The event tap needs the Accessibility permission, granted to Shogo (the
// responsible parent process).
//
// Protocol
//   argv:   --push-to-talk=<chord>      optional initial chord ("none" disables)
//   stdin:  newline-delimited commands
//             set <chord|none>          change the chord
//             paste                     post Cmd+V to the focused app
//             quit                      exit
//   stdout: newline-delimited JSON events
//             {"event":"ready"}
//             {"event":"waiting","reason":"not-trusted"}   tap not allowed yet; retrying
//             {"event":"listening","chord":"fn"}
//             {"event":"ptt","down":true|false}
//             {"event":"combo"}         another key was pressed during an Fn hold
//             {"event":"pasted"}
//             {"event":"error","message":"..."}

import Foundation
import CoreGraphics
import ApplicationServices

// MARK: - Output

let outputQueue = DispatchQueue(label: "shogo-hotkey.out")

func emit(_ object: [String: Any]) {
    outputQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }
}

// MARK: - Chord parsing

struct Chord {
    var modifiers: CGEventFlags
    var keyCode: Int64?
    var description: String
}

let relevantFlags: CGEventFlags = [.maskSecondaryFn, .maskControl, .maskAlternate, .maskCommand, .maskShift]

let keyCodes: [String: Int64] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46, "space": 49, "tab": 48, "return": 36, "enter": 36, "escape": 53, "esc": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111,
]

func parseChord(_ spec: String) -> Chord? {
    let trimmed = spec.trimmingCharacters(in: .whitespaces).lowercased()
    if trimmed.isEmpty || trimmed == "none" { return nil }
    var flags: CGEventFlags = []
    var key: Int64? = nil
    for token in trimmed.split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch token {
        case "fn", "function", "globe": flags.insert(.maskSecondaryFn)
        case "control", "ctrl": flags.insert(.maskControl)
        case "option", "alt": flags.insert(.maskAlternate)
        case "command", "cmd", "commandorcontrol", "cmdorctrl": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        default:
            guard let code = keyCodes[token], key == nil else { return nil }
            key = code
        }
    }
    if flags.isEmpty && key == nil { return nil }
    // A bare key (no modifiers) would hijack normal typing.
    if flags.isEmpty { return nil }
    return Chord(modifiers: flags, keyCode: key, description: trimmed)
}

// MARK: - State

final class State {
    var chord: Chord?
    var active = false
    var keyIsDown = false
    /// Set when another key joins an Fn-only hold, so the hold is not treated as dictation.
    var comboSeen = false
    var tap: CFMachPort?
}

let state = State()

func currentModifiers(_ flags: CGEventFlags) -> CGEventFlags {
    return flags.intersection(relevantFlags)
}

func setActive(_ next: Bool) {
    guard next != state.active else { return }
    state.active = next
    if next { state.comboSeen = false }
    emit(["event": "ptt", "down": next])
}

func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
    guard let chord = state.chord else { return Unmanaged.passUnretained(event) }
    let mods = currentModifiers(event.flags)
    let modsMatch = mods == chord.modifiers

    switch type {
    case .flagsChanged:
        if chord.keyCode == nil {
            setActive(modsMatch)
        } else if !modsMatch {
            state.keyIsDown = false
            setActive(false)
        }
    case .keyDown:
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if let key = chord.keyCode {
            if code == key && modsMatch {
                let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
                state.keyIsDown = true
                if !isRepeat { setActive(true) }
                return nil // swallow so the chord does not type characters
            }
        } else if state.active && !state.comboSeen {
            // Modifier-only chord (Fn): another key means the user wants Fn+key.
            state.comboSeen = true
            emit(["event": "combo"])
        }
    case .keyUp:
        if let key = chord.keyCode, event.getIntegerValueField(.keyboardEventKeycode) == key, state.keyIsDown {
            state.keyIsDown = false
            setActive(false)
            return nil
        }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = state.tap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    return handle(type: type, event: event)
}

var waitingReported = false

/// Create the event tap once Accessibility is granted. Retries until it works.
func installTap() {
    if state.tap != nil { return }
    let mask: CGEventMask =
        (1 << CGEventType.keyDown.rawValue) |
        (1 << CGEventType.keyUp.rawValue) |
        (1 << CGEventType.flagsChanged.rawValue)

    guard AXIsProcessTrusted(),
          let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: tapCallback,
            userInfo: nil
          )
    else {
        if !waitingReported {
            waitingReported = true
            emit(["event": "waiting", "reason": "not-trusted"])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { installTap() }
        return
    }

    state.tap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit(["event": "listening", "chord": state.chord?.description ?? "none"])
}

// MARK: - Commands

func setChord(_ spec: String) {
    state.active = false
    state.keyIsDown = false
    state.comboSeen = false
    state.chord = parseChord(spec)
    if state.tap != nil {
        emit(["event": "listening", "chord": state.chord?.description ?? "none"])
    }
}

func pasteIntoFocusedApp() {
    let source = CGEventSource(stateID: .combinedSessionState)
    let vKey: CGKeyCode = 9
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false) else {
        emit(["event": "error", "message": "could not create paste events"])
        return
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    emit(["event": "pasted"])
}

func handleCommand(_ line: String) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    guard let command = parts.first else { return }
    switch command {
    case "set":
        setChord(parts.count > 1 ? parts[1] : "none")
    case "paste":
        pasteIntoFocusedApp()
    case "quit":
        outputQueue.sync {}
        exit(0)
    default:
        emit(["event": "error", "message": "unknown command: \(command)"])
    }
}

// MARK: - Main

for arg in CommandLine.arguments.dropFirst() where arg.hasPrefix("--push-to-talk=") {
    setChord(String(arg.dropFirst("--push-to-talk=".count)))
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        DispatchQueue.main.async { handleCommand(line) }
    }
    // stdin closed: the parent is gone.
    outputQueue.sync {}
    exit(0)
}

emit(["event": "ready"])
DispatchQueue.main.async { installTap() }
CFRunLoopRun()
