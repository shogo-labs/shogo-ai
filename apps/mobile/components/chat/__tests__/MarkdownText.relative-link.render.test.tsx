// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A message that links a workspace file relatively (`[plans/a.md](plans/a.md)`)
 * must never render as the text plus `[blocked]` (SHO-242).
 *
 * Streamdown runs `rehype-harden` on every body and that plugin only accepts a
 * relative href starting with `/`, `./` or `../`; a bare `plans/a.md` is
 * replaced with `<span title="Blocked URL: …">text [blocked]</span>`. The body
 * is now resolved before it reaches the parser: a file link when the host can
 * open files, plain text otherwise.
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

afterEach(cleanup)

const RELATIVE = "[plans/a.md](plans/a.md)"

describe("a relative file link in a message", () => {
  test("is a file chip when the host can open files", () => {
    const container = render(
      <MarkdownText isStreaming={false} onFilePress={() => {}} fileExists={() => true}>
        {RELATIVE}
      </MarkdownText>,
    ).container

    expect(container.textContent).not.toContain("[blocked]")
    const chip = container.querySelector('[data-testid="chat-file-chip"]')
    expect(chip?.textContent).toBe("a.md")
    expect(chip?.getAttribute("href")).toBe("/shogo-file?path=plans%2Fa.md")
  })

  test("is plain text, with no anchor at all, when nothing can open it", () => {
    const container = render(
      <MarkdownText isStreaming={false}>{RELATIVE}</MarkdownText>,
    ).container

    expect(container.textContent).not.toContain("[blocked]")
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("plans/a.md")
  })

  test("keeps a path that exists in the index as a link when the file is not there", () => {
    const container = render(
      <MarkdownText isStreaming={false} onFilePress={() => {}} fileExists={() => false}>
        {RELATIVE}
      </MarkdownText>,
    ).container

    expect(container.textContent).not.toContain("[blocked]")
    expect(container.querySelector('[data-testid="chat-file-chip"]')).toBeNull()
    expect(container.querySelector('[data-testid="chat-file-link"]')?.textContent).toBe("plans/a.md")
  })

  test("prose around the link survives, and a ../ link is never opened", () => {
    const container = render(
      <MarkdownText isStreaming={false} onFilePress={() => {}}>
        {"see [the plan](plans/a.md) and [the key](../secret.txt)"}
      </MarkdownText>,
    ).container

    expect(container.textContent).not.toContain("[blocked]")
    expect(container.textContent).toContain("see the plan and the key")
    expect(container.querySelector('a[href="../secret.txt"]')).toBeNull()
  })
})
