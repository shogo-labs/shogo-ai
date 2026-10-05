// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In the Electron app the composer mic must not use `webkitSpeechRecognition`
 * (it has no backend there). It records locally, transcribes through the
 * local API, and surfaces a blocked mic with a way to open System Settings.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act, render } from "@testing-library/react"
import * as React from "react"

mock.module("react-native", () => ({ Platform: { OS: "web" } }))

class MicPermissionError extends Error {}

const openMicrophoneSettings = mock(async () => ({ ok: true }))
const session = {
  stop: mock(async () => new Blob(["RIFF"], { type: "audio/wav" }) as Blob | null),
  cancel: mock(() => {}),
}
const startDesktopDictation = mock(async () => session)
const transcribeDesktopClip = mock(async (_wav: Blob) => "hello world")

mock.module("../desktop-dictation", () => ({
  getDesktopBridge: () => ({ isDesktop: true, openMicrophoneSettings }),
  MicPermissionError,
  startDesktopDictation,
  transcribeDesktopClip,
}))

// A speech constructor that would make the browser path look "supported".
const speechCtor = mock(function SpeechRecognition() {})
;(window as any).webkitSpeechRecognition = speechCtor
if (!navigator.mediaDevices?.getUserMedia) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => ({}) },
    configurable: true,
  })
}

const { useVoiceInput } = await import("../useVoiceInput")

type Voice = ReturnType<typeof useVoiceInput>
let voice: Voice
const transcripts: string[] = []

function Probe() {
  voice = useVoiceInput({ onTranscript: (t) => transcripts.push(t) })
  return null
}

beforeEach(() => {
  transcripts.length = 0
  session.stop.mockClear()
  session.cancel.mockClear()
  startDesktopDictation.mockReset()
  startDesktopDictation.mockImplementation(async () => session)
  transcribeDesktopClip.mockReset()
  transcribeDesktopClip.mockImplementation(async () => "hello world")
  openMicrophoneSettings.mockClear()
  speechCtor.mockClear()
})

describe("useVoiceInput on desktop", () => {
  test("records, transcribes via the local API, and never touches SpeechRecognition", async () => {
    render(<Probe />)
    expect(voice.canRecord).toBe(true)

    await act(async () => { await voice.toggleRecording() })
    expect(voice.isRecording).toBe(true)
    expect(startDesktopDictation).toHaveBeenCalledTimes(1)

    await act(async () => { await voice.toggleRecording() })
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(transcribeDesktopClip).toHaveBeenCalledTimes(1)
    expect(transcripts).toEqual(["hello world"])
    expect(voice.isBusy).toBe(false)
    expect(voice.error).toBeNull()
    expect(speechCtor).not.toHaveBeenCalled()
  })

  test("a blocked mic shows guidance and opens System Settings on request", async () => {
    startDesktopDictation.mockImplementation(async () => { throw new MicPermissionError() })
    render(<Probe />)

    await act(async () => { await voice.toggleRecording() })
    expect(voice.isRecording).toBe(false)
    expect(voice.micBlocked).toBe(true)
    expect(voice.error).toContain("System Settings")

    act(() => voice.openMicSettings())
    expect(openMicrophoneSettings).toHaveBeenCalledTimes(1)

    act(() => voice.clearError())
    expect(voice.micBlocked).toBe(false)
    expect(voice.error).toBeNull()
  })

  test("other start failures are shown without the settings action", async () => {
    startDesktopDictation.mockImplementation(async () => { throw new Error("No microphone was found.") })
    render(<Probe />)

    await act(async () => { await voice.toggleRecording() })
    expect(voice.micBlocked).toBe(false)
    expect(voice.error).toBe("No microphone was found.")
  })

  test("empty audio reports no speech instead of inserting text", async () => {
    session.stop.mockImplementationOnce(async () => null)
    render(<Probe />)

    await act(async () => { await voice.toggleRecording() })
    await act(async () => { await voice.toggleRecording() })
    expect(transcribeDesktopClip).not.toHaveBeenCalled()
    expect(transcripts).toEqual([])
    expect(voice.error).toBe("No speech detected. Please try again.")
    expect(voice.isBusy).toBe(false)
  })

  test("a transcription failure is surfaced and the mic returns to idle", async () => {
    transcribeDesktopClip.mockImplementation(async () => { throw new Error("Transcription needs Shogo Cloud") })
    render(<Probe />)

    await act(async () => { await voice.toggleRecording() })
    await act(async () => { await voice.toggleRecording() })
    expect(voice.error).toBe("Transcription needs Shogo Cloud")
    expect(voice.isBusy).toBe(false)
  })
})
