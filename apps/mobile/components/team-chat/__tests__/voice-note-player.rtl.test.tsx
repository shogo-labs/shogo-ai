// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The voice-note player as a reader meets it: play/pause, the waveform it
 * draws, the clock, and the speed menu.
 *
 * The audio engine is faked, so this asserts on what the player asks the
 * store to do rather than on any platform audio API.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import type { VoiceNotePlayerProps } from "../VoiceNotePlayer"
import { WAVEFORM_BARS } from "../../../lib/voice-note"

const engine = {
  loaded: [] as string[],
  plays: 0,
  pauses: 0,
  seeks: [] as number[],
  rates: [] as number[],
}

mock.module(resolve(import.meta.dir, "../../../lib/voice-playback-engine"), () => ({
  createVoicePlaybackEngine: () => ({
    load: (url: string) => engine.loaded.push(url),
    play: () => {
      engine.plays += 1
    },
    pause: () => {
      engine.pauses += 1
    },
    seek: (seconds: number) => engine.seeks.push(seconds),
    setRate: (rate: number) => engine.rates.push(rate),
    release: () => {},
  }),
}))

// The real shared-ui pulls in react-native; only `cn` is needed here.
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

// onLayout is not a DOM event, so the shim captures the handler and the test
// drives it, which is what lets the waveform be measured before a tap. A DOM
// click carries no touch position either, so the test sets one.
const layoutHandlers = new WeakMap<Element, (event: unknown) => void>()
let nextTapLocationX: number | undefined

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: {
      OS: "web",
      Version: 0,
      isPad: false,
      isTV: false,
      select: <T,>(spec: { web?: T; default?: T }) => spec.web,
    },
    // Test doubles, so they only need to behave like the RN components.
    Pressable: (({
      accessibilityLabel,
      children,
      onPress,
      onLayout,
      ...props
    }: {
      accessibilityLabel?: string
      children?: ReactNode
      onPress?: (event: unknown) => void
      onLayout?: (event: unknown) => void
    }) =>
      createElement(
        "div",
        {
          ...props,
          role: "button",
          "aria-label": accessibilityLabel,
          ref: (node: Element) => {
            if (node && onLayout) layoutHandlers.set(node, onLayout)
          },
          // A DOM event carries no RN touch position, so the test supplies one.
          onClick: () => onPress?.({ nativeEvent: { locationX: nextTapLocationX } }),
        },
        children,
      )) as never,
    Modal: (({ children, visible }: { children?: ReactNode; visible?: boolean }) =>
      visible ? createElement("div", { "data-testid": "speed-menu" }, children) : null) as never,
  }),
)

mock.module("lucide-react-native", () => ({
  Play: () => createElement("span", null, "play-icon"),
  Pause: () => createElement("span", null, "pause-icon"),
}))

const { VoiceNotePlayer } = await import("../VoiceNotePlayer")
const { readVoicePlayback, setVoiceNoteSpeed, stopVoiceNote } = await import("../../../lib/voice-playback")

const CLIP: VoiceNotePlayerProps = {
  attachmentId: "att-1",
  url: "https://api.test/api/conversation-files/att-1?t=signed",
  durationMs: 10_000,
  peaks: "20 40 60 80 100 60 40 20",
  name: "Voice note.m4a",
}

function renderPlayer(overrides: Partial<VoiceNotePlayerProps> = {}) {
  return render(createElement(VoiceNotePlayer, { ...CLIP, ...overrides }))
}

beforeEach(() => {
  stopVoiceNote()
  engine.loaded = []
  engine.plays = 0
  engine.pauses = 0
  engine.seeks = []
  engine.rates = []
})

afterEach(cleanup)

describe('what the player shows before it is played', () => {
  test('offers a play button and the length of the clip', () => {
    renderPlayer()
    expect(screen.getByLabelText("Play Voice note.m4a")).toBeDefined()
    expect(screen.getByText("0:10")).toBeDefined()
  })

  test('draws the waveform from the peaks stored with the message', () => {
    renderPlayer({ peaks: "20 40 60 80 100 60 40 20" })
    const track = screen.getByLabelText("Seek Voice note.m4a")
    // Eight stored levels is under the bar budget, so all eight are drawn.
    expect(track.firstElementChild!.children.length).toBe(8)
  })

  test('compresses a clip that stored more levels than it draws', () => {
    const peaks = Array.from({ length: 200 }, (_, i) => String((i * 7) % 100)).join(" ")
    renderPlayer({ peaks })
    const track = screen.getByLabelText("Seek Voice note.m4a")
    expect(track.firstElementChild!.children.length).toBe(WAVEFORM_BARS)
  })

  test('still draws a waveform for a clip that has none', () => {
    renderPlayer({ peaks: null })
    const track = screen.getByLabelText("Seek Voice note.m4a")
    expect(track.firstElementChild!.children.length).toBe(WAVEFORM_BARS)
  })

  test('shows the current speed', () => {
    renderPlayer()
    expect(screen.getByLabelText("Playback speed 1x")).toBeDefined()
  })
})

describe('playing and pausing', () => {
  test('starts the clip, then pauses it on the next press', () => {
    renderPlayer()
    fireEvent.click(screen.getByLabelText("Play Voice note.m4a"))
    expect(engine.loaded).toEqual([CLIP.url])
    expect(engine.plays).toBe(1)
    expect(readVoicePlayback().isPlaying).toBe(true)

    fireEvent.click(screen.getByLabelText("Pause Voice note.m4a"))
    expect(engine.pauses).toBe(1)
    expect(readVoicePlayback().isPlaying).toBe(false)
  })
})

describe('seeking', () => {
  const measure = (width: number) => {
    const track = screen.getByLabelText("Seek Voice note.m4a")
    act(() => {
      layoutHandlers.get(track)!({ nativeEvent: { layout: { width } } })
    })
    return track
  }

  test('starts the clip at the point that was tapped', () => {
    renderPlayer()
    const track = measure(200)
    nextTapLocationX = 50
    fireEvent.click(track)
    nextTapLocationX = undefined

    expect(engine.loaded).toEqual([CLIP.url])
    expect(engine.plays).toBe(1)
    expect(engine.seeks).toEqual([2.5])
    expect(readVoicePlayback().positionMs).toBe(2_500)
  })

  test('seeks to the end when the tap lands on the last bar', () => {
    renderPlayer()
    const track = measure(200)
    nextTapLocationX = 200
    fireEvent.click(track)
    nextTapLocationX = undefined
    expect(engine.seeks).toEqual([10])
  })

  test('moves the playhead of the clip already playing', () => {
    renderPlayer()
    const track = measure(200)
    fireEvent.click(screen.getByLabelText("Play Voice note.m4a"))
    engine.seeks = []

    nextTapLocationX = 100
    fireEvent.click(track)
    nextTapLocationX = undefined

    expect(engine.loaded).toEqual([CLIP.url])
    expect(engine.seeks).toEqual([5])
  })

  test('ignores a tap before the track has been measured', () => {
    renderPlayer()
    nextTapLocationX = 50
    fireEvent.click(screen.getByLabelText("Seek Voice note.m4a"), { nativeEvent: { locationX: 50 } })
    nextTapLocationX = undefined
    expect(engine.seeks).toEqual([])
  })
})

describe('the speed menu', () => {
  test('offers the three speeds and applies the chosen one', () => {
    renderPlayer()
    fireEvent.click(screen.getByLabelText("Playback speed 1x"))

    const menu = screen.getByTestId("speed-menu")
    expect(menu.textContent).toContain("1x")
    expect(menu.textContent).toContain("1.5x")
    expect(menu.textContent).toContain("2x")

    fireEvent.click(screen.getByLabelText("Play at 2x"))
    expect(readVoicePlayback().rate).toBe(2)
    // The menu closes once a speed is picked.
    expect(screen.queryByTestId("speed-menu")).toBeNull()
  })

  test('reports the chosen speed on the button afterwards', () => {
    renderPlayer()
    act(() => {
      setVoiceNoteSpeed(1.5)
    })
    expect(screen.getByLabelText("Playback speed 1.5x")).toBeDefined()
  })
})
