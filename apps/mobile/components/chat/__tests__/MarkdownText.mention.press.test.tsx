// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tapping an @-mention opens the mentioned person's or agent's profile — while
 * the tag itself stays a highlight rather than a link, so it keeps standing out
 * from the links around it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
  }),
)

const { MarkdownText } = await import("../MarkdownText.web")
const { renderMentionsMarkdown } = await import("../../../lib/team-chat-state")

afterEach(cleanup)

const names = {
  users: new Map([["u1", "Ana Lopez"]]),
  agents: new Map([["p:p1", "Billing Bot"]]),
}

function renderBody(text: string, onMentionPress?: (target: any) => void) {
  return render(
    <MarkdownText isStreaming={false} onMentionPress={onMentionPress}>
      {renderMentionsMarkdown(text, names)}
    </MarkdownText>,
  ).container
}

const mentions = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="chat-mention"]'))

describe("tapping a mention", () => {
  test("reports the person it points at", () => {
    const onMentionPress = mock(() => {})
    const container = renderBody("hey <@u:u1>", onMentionPress)

    fireEvent.click(mentions(container)[0]!)
    expect(onMentionPress).toHaveBeenCalledTimes(1)
    expect(onMentionPress).toHaveBeenCalledWith({ kind: "u", id: "u1" })
  })

  test("reports the agent, whose key holds a colon", () => {
    const onMentionPress = mock(() => {})
    const container = renderBody("<@a:p:p1> please review", onMentionPress)

    fireEvent.click(mentions(container)[0]!)
    expect(onMentionPress).toHaveBeenCalledWith({ kind: "a", id: "p:p1" })
  })

  test("is keyboard reachable, as a button", () => {
    const onMentionPress = mock(() => {})
    const container = renderBody("<@u:u1>", onMentionPress)
    const tag = mentions(container)[0]!

    expect(tag.getAttribute("role")).toBe("button")
    expect(tag.getAttribute("tabindex")).toBe("0")
    fireEvent.keyDown(tag, { key: "Enter" })
    expect(onMentionPress).toHaveBeenCalledWith({ kind: "u", id: "u1" })
  })

  test("still looks like a highlight, not a link", () => {
    const onMentionPress = mock(() => {})
    const container = renderBody("hey <@u:u1>, see https://example.com", onMentionPress)

    const tag = mentions(container)[0]!
    expect(tag.tagName).toBe("SPAN")
    expect(tag.className).toContain("bg-yellow")
    // The only anchor is the real URL: a mention must not become one.
    expect(Array.from(container.querySelectorAll("a")).map((a) => a.textContent)).toEqual([
      "https://example.com",
    ])
  })

  test("does nothing when the host offers no profile", () => {
    const container = renderBody("hey <@u:u1>")
    const tag = mentions(container)[0]!

    expect(tag.tagName).toBe("SPAN")
    expect(tag.getAttribute("role")).toBeNull()
    expect(tag.getAttribute("tabindex")).toBeNull()
    expect(() => fireEvent.click(tag)).not.toThrow()
  })

  test("a target-less mention is never pressable", () => {
    const onMentionPress = mock(() => {})
    const container = renderBody("<!here> and <#c:c1>", onMentionPress)

    const tags = mentions(container)
    expect(tags.map((t) => t.textContent)).toEqual(["@here", "#channel"])
    for (const tag of tags) {
      expect(tag.getAttribute("role")).toBeNull()
      fireEvent.click(tag)
    }
    expect(onMentionPress).not.toHaveBeenCalled()
  })
})
