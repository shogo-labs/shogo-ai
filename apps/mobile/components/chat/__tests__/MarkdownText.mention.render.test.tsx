// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A rendered @-mention is a yellow highlight, not a link, so a tag stands out
 * from the bold and links around it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
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
  agents: new Map([["ws", "Shogo"]]),
}

function renderBody(text: string, onFilePress?: (path: string) => void) {
  return render(
    <MarkdownText isStreaming={false} onFilePress={onFilePress}>
      {renderMentionsMarkdown(text, names)}
    </MarkdownText>,
  ).container
}

describe("a mention in a rendered message", () => {
  test("is a highlighted span, not a link", () => {
    const container = renderBody("hey <@u:u1>, ask <@a:ws> or see https://example.com")

    const tags = Array.from(container.querySelectorAll('[data-testid="chat-mention"]'))
    expect(tags.map((t) => t.textContent)).toEqual(["@Ana Lopez", "@Shogo"])
    expect(tags.every((t) => t.tagName === "SPAN" && t.className.includes("bg-yellow"))).toBe(true)
    const links = Array.from(container.querySelectorAll("a"))
    expect(links.map((a) => a.textContent)).toEqual(["https://example.com"])
  })

  test("stays a highlight when file links are enabled", () => {
    const container = renderBody("<@u:u1> check src/app.ts", () => {})

    expect(container.querySelector('[data-testid="chat-mention"]')?.textContent).toBe("@Ana Lopez")
    expect(container.querySelector('[data-testid="chat-file-link"]')?.textContent).toBe("src/app.ts")
  })
})
