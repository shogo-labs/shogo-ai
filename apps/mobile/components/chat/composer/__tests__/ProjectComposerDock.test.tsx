// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from "bun:test"
import { render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

const { Animated } = await import("react-native")
const { CHAT_TRANSCRIPT_MAX_WIDTH } = await import("../../../../lib/native-composer-keyboard")
const { ProjectComposerDock } = await import("../ProjectComposerDock")

describe("ProjectComposerDock", () => {
  test("puts the animated keyboard pad on Animated.View so iOS can lift the pill", () => {
    const pad = new Animated.Value(34)
    const { container } = render(
      <ProjectComposerDock columnWidth={390} keyboardPad={pad} applyKeyboardPad native>
        <div>composer</div>
      </ProjectComposerDock>,
    )
    const dock = container.querySelector('[data-rn-shim="project-composer-dock"]') as HTMLElement
    expect(dock).toBeTruthy()
    expect(dock.style.width).toBe("390px")
  })

  test("centers the web composer with the transcript column", () => {
    const pad = new Animated.Value(12)
    const { container } = render(
      <ProjectComposerDock keyboardPad={pad} applyKeyboardPad={false} native={false}>
        <div>composer</div>
      </ProjectComposerDock>,
    )
    const dock = container.querySelector('[data-rn-shim="project-composer-dock"]') as HTMLElement
    expect(dock.style.width).toBe("100%")
    expect(dock.style.maxWidth).toBe(`${CHAT_TRANSCRIPT_MAX_WIDTH}px`)
    expect(dock.style.paddingBottom).toBe("")
  })
})
