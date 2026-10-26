// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A rendered @-mention is a yellow highlight, not a link, so a tag stands out
 * from the bold and links around it.
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

describe("a file path in a rendered message", () => {
  function renderFiles(text: string, existing: string[], onFilePress = mock((_: string) => {})) {
    const fileExists = (path: string) => existing.includes(path)
    const { container } = render(
      <MarkdownText isStreaming={false} onFilePress={onFilePress} fileExists={fileExists}>
        {text}
      </MarkdownText>,
    )
    return { container, onFilePress }
  }

  test("is a file chip link when the file exists", () => {
    const { container, onFilePress } = renderFiles("Updated `src/app.tsx` and docs/guide.md.", [
      "src/app.tsx",
      "docs/guide.md",
    ])

    const chips = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="chat-file-chip"]'))
    expect(chips.map((c) => c.textContent)).toEqual(["app.tsx", "guide.md"])
    expect(chips.map((c) => c.title)).toEqual(["src/app.tsx", "docs/guide.md"])
    expect(chips.every((c) => c.tagName === "A" && c.querySelector("code") === null)).toBe(true)
    expect(chips.map((c) => c.querySelector("[data-file-icon]")?.getAttribute("data-file-icon"))).toEqual([
      "atom",
      "M↓",
    ])

    fireEvent.click(chips[0]!)
    expect(onFilePress).toHaveBeenCalledWith("src/app.tsx")
  })

  test("stays inline code when the file can't be found", () => {
    const { container } = renderFiles("See `src/missing.ts`.", ["src/app.tsx"])

    expect(container.querySelector('[data-testid="chat-file-chip"]')).toBeNull()
    const link = container.querySelector('[data-testid="chat-file-link"]')
    expect(link?.querySelector("code")?.textContent).toBe("src/missing.ts")
  })
})
