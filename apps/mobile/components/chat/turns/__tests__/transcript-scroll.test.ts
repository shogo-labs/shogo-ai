// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-359 — the transcript scroll signal carries where an offset came from, and
 * the browser's own scroll anchoring is switched off so the turn window is the
 * only thing that corrects the reading position.
 */

import { describe, expect, test } from "bun:test"
import {
  createTranscriptScrollSignal,
  optOutOfBrowserScrollAnchoring,
} from "../transcript-scroll"

describe("transcript scroll signal", () => {
  test("a plain report is labelled as the person scrolling", () => {
    const signal = createTranscriptScrollSignal()
    const seen: string[] = []
    signal.subscribe((origin) => seen.push(origin))

    signal.report({ y: 100, viewportHeight: 800, contentHeight: 5_000 })

    expect(seen).toEqual(["scroll"])
  })

  test("a correction is stored but labelled, so the window can ignore it", () => {
    const signal = createTranscriptScrollSignal()
    const samples: Array<{ y: number; origin: string }> = []
    signal.subscribe((origin) => {
      samples.push({ y: signal.read().y, origin })
    })

    signal.report(
      { y: 100, viewportHeight: 800, contentHeight: 5_000 },
      "correction",
    )

    expect(samples).toEqual([{ y: 100, origin: "correction" }])
    // Still the truth for anyone who reads it later (the retry timer, the next
    // expansion's own maths).
    expect(signal.read().y).toBe(100)
  })

  test("an identical offset is not reported twice", () => {
    const signal = createTranscriptScrollSignal()
    let reports = 0
    signal.subscribe(() => reports++)

    const sample = { y: 100, viewportHeight: 800, contentHeight: 5_000 }
    signal.report(sample)
    signal.report({ ...sample })

    expect(reports).toBe(1)
  })

  test("unsubscribing stops reports", () => {
    const signal = createTranscriptScrollSignal()
    let reports = 0
    const unsubscribe = signal.subscribe(() => reports++)
    unsubscribe()

    signal.report({ y: 200, viewportHeight: 800, contentHeight: 5_000 })

    expect(reports).toBe(0)
  })
})

describe("optOutOfBrowserScrollAnchoring", () => {
  test("switches anchoring off on the node it is given", () => {
    const node = { style: {} as { overflowAnchor?: string } }

    optOutOfBrowserScrollAnchoring(node)

    expect(node.style.overflowAnchor).toBe("none")
  })

  test("tolerates a missing node (native, or a ref that has not attached yet)", () => {
    expect(() => optOutOfBrowserScrollAnchoring(null)).not.toThrow()
    expect(() => optOutOfBrowserScrollAnchoring(undefined)).not.toThrow()
    expect(() => optOutOfBrowserScrollAnchoring({})).not.toThrow()
  })
})
