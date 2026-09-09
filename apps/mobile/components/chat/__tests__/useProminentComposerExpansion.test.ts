// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { shouldStackProminentComposer, nextProminentComposerHeight } from "../useProminentComposerExpansion"

describe("shouldStackProminentComposer", () => {
  const base = {
    empty: false,
    text: "hello",
    slotWidth: 180,
    textWidth: 40,
    contentHeight: 24,
    lineHeight: 22,
    currentlyStacked: false,
  }

  test("stays compact while the first line still fits the toolbar slot", () => {
    expect(shouldStackProminentComposer(base)).toBe(false)
  })

  test("expands once the line would wrap in the compact slot", () => {
    expect(shouldStackProminentComposer({ ...base, textWidth: 181 })).toBe(true)
  })

  test("does not collapse immediately after expanding to full width", () => {
    expect(
      shouldStackProminentComposer({
        ...base,
        currentlyStacked: true,
        textWidth: 175,
      }),
    ).toBe(true)
  })

  test("collapses when the composer is emptied", () => {
    expect(
      shouldStackProminentComposer({
        ...base,
        empty: true,
        currentlyStacked: true,
        textWidth: 400,
      }),
    ).toBe(false)
  })

  test("expands on an explicit newline even if the first line is short", () => {
    expect(
      shouldStackProminentComposer({
        ...base,
        text: "hi\nthere",
        textWidth: 20,
      }),
    ).toBe(true)
  })
})

describe("nextProminentComposerHeight", () => {
  test("maps wrapped content to the clamped height and empty content to the min height", () => {
    expect(
      nextProminentComposerHeight(54, {
        empty: false,
        minHeight: 24,
        maxHeight: 132,
        lineHeight: 22,
      }),
    ).toBe(54)
    expect(
      nextProminentComposerHeight(22, {
        empty: false,
        minHeight: 24,
        maxHeight: 132,
        lineHeight: 22,
      }),
    ).toBe(24)
    expect(
      nextProminentComposerHeight(80, {
        empty: true,
        minHeight: 24,
        maxHeight: 132,
        lineHeight: 22,
      }),
    ).toBe(24)
  })
})
