// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A path chips as soon as the file index knows the file, without the message
 * text changing (SHO-280).
 *
 * The index usually arrives after the first render of a reply: a project's
 * file list is fetched when something first asks about one of its paths. So
 * the same text has to flip from `chat-file-link` to `chat-file-chip` when
 * `fileExists` starts answering true. streamdown@2.7.0's outer `memo` ignores
 * `components`, so a `fileExists` handed to the links through that map would
 * never arrive — it reaches them through context instead.
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

const TEXT = "see `plans/x.md`"
const onFilePress = () => {}

function renderWith(fileExists: (path: string) => boolean) {
  return render(
    <MarkdownText isStreaming={false} onFilePress={onFilePress} fileExists={fileExists}>
      {TEXT}
    </MarkdownText>,
  )
}

describe("a path the file index learns about later", () => {
  test("chips on the same text once fileExists starts returning true", () => {
    const view = renderWith(() => false)

    expect(view.container.querySelector('[data-testid="chat-file-chip"]')).toBeNull()
    expect(
      view.container.querySelector('[data-testid="chat-file-link"]')?.textContent,
    ).toBe("plans/x.md")

    view.rerender(
      <MarkdownText isStreaming={false} onFilePress={onFilePress} fileExists={() => true}>
        {TEXT}
      </MarkdownText>,
    )

    const chip = view.container.querySelector('[data-testid="chat-file-chip"]')
    expect(chip?.textContent).toBe("x.md")
    expect(view.container.querySelector('[data-testid="chat-file-link"]')).toBeNull()
  })

  test("goes back to a plain link when the file is gone", () => {
    const view = renderWith(() => true)
    expect(view.container.querySelector('[data-testid="chat-file-chip"]')?.textContent).toBe("x.md")

    view.rerender(
      <MarkdownText isStreaming={false} onFilePress={onFilePress} fileExists={() => false}>
        {TEXT}
      </MarkdownText>,
    )

    expect(view.container.querySelector('[data-testid="chat-file-chip"]')).toBeNull()
    expect(
      view.container.querySelector('[data-testid="chat-file-link"]')?.textContent,
    ).toBe("plans/x.md")
  })
})
