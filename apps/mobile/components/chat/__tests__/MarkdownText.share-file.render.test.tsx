// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A link to a file the API serves is a chip that opens the app's own viewer —
 * never an anchor that would navigate to the API's JSON in a new tab (SHO-80).
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
const { ShareFileProvider } = await import("../share-file-context")

afterEach(cleanup)

function token(path: string): string {
  const claims = {
    typ: "shared-file",
    workspaceId: "ws-1",
    path,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  }
  return `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.c2ln`
}

function renderInApp(text: string, open: (target: unknown) => void) {
  return render(
    <ShareFileProvider open={open}>
      <MarkdownText isStreaming={false}>{text}</MarkdownText>
    </ShareFileProvider>,
  )
}

describe("a share_file link in a message", () => {
  test("renders a chip named after the file, not a link out of the app", () => {
    const href = `https://studio.shogo.ai/api/f/${token("exports/summary.csv")}`
    const container = renderInApp(`Here it is: [download](${href})`, () => {}).container

    const chip = container.querySelector('[data-testid="chat-file-chip"]')
    expect(chip?.textContent).toBe("summary.csv")
    expect(chip?.getAttribute("data-file-kind")).toBe("share")
    expect(container.querySelector('a[target="_blank"]')).toBeNull()
  })

  test("opens the app's viewer instead of navigating", () => {
    const opened: Array<Record<string, unknown>> = []
    const href = `http://localhost:39100/api/f/${token("reports/q4.pdf")}`
    const container = renderInApp(`[Q4 report](${href})`, (target) =>
      opened.push(target as Record<string, unknown>),
    ).container

    const chip = container.querySelector('[data-testid="chat-file-chip"]') as HTMLAnchorElement
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    fireEvent(chip, event)

    expect(event.defaultPrevented).toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ kind: "share", href })
  })

  test("a stored chat attachment is a chip too", () => {
    const opened: Array<Record<string, unknown>> = []
    const container = renderInApp(
      "See [notes](/api/chat-attachments/key-1/notes.md?sig=abc)",
      (target) => opened.push(target as Record<string, unknown>),
    ).container

    const chip = container.querySelector('[data-testid="chat-file-chip"]')
    expect(chip?.textContent).toBe("notes.md")
    fireEvent.click(chip as HTMLElement)
    expect(opened[0]).toMatchObject({ kind: "stored", href: "/api/chat-attachments/key-1/notes.md?sig=abc" })
  })

  test("a token that ends in `_` reaches the opener intact", () => {
    const opened: Array<Record<string, unknown>> = []
    const signed = `${token("a/token.txt")}_`
    const href = `https://studio.shogo.ai/api/f/${signed}`
    const container = renderInApp(`[download](${href})`, (target) =>
      opened.push(target as Record<string, unknown>),
    ).container

    fireEvent.click(container.querySelector('[data-testid="chat-file-chip"]') as HTMLElement)
    expect(opened[0]?.href).toBe(href)
  })

  test("without a host to open it, nothing leaves the app on its own", () => {
    const container = render(
      <MarkdownText isStreaming={false}>{`[x](/api/f/${token("a/b.txt")})`}</MarkdownText>,
    ).container
    // No provider: the markdown still renders its anchor, but this test exists
    // to prove the app never opens a window by itself.
    expect(container.querySelector('[data-testid="chat-file-chip"]')).toBeNull()
  })

  test("an ordinary link is left alone", () => {
    const container = renderInApp("[docs](https://github.com/shogo-labs/shogo-ai)", () => {}).container
    expect(container.querySelector('[data-testid="chat-file-chip"]')).toBeNull()
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/shogo-labs/shogo-ai",
    )
  })
})
