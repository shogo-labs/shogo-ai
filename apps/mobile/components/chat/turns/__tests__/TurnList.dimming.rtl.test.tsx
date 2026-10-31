// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-263 AC 4 — while an edit is open, every turn below it is dimmed and
 * sits under a "N messages below will be replaced" divider. Guards the
 * context → TurnList wiring (the pure index helper is covered in
 * editResend.test.ts).
 */

import { describe, expect, mock, test } from "bun:test"
import { resolve } from "node:path"
import { render } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const mockAt = (relative: string, factory: () => unknown) =>
  mock.module(resolve(import.meta.dir, relative), factory as any)

const rnMock = () =>
  createReactNativeMock({
    Text: ({ children, ...rest }: any) =>
      createElement("span", { ...rest, style: undefined }, children),
    View: ({ children, ...rest }: any) =>
      createElement("div", { ...rest, style: undefined }, children),
  })

mock.module("react-native", () => rnMock())
mock.module(require.resolve("react-native"), () => rnMock())
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
// Not used by TurnList, but something in its module graph evaluates
// expo-router's splash helper at import time.
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
}))
mockAt("../useTurnGrouping.ts", () => ({
  useTurnGrouping: () => [
    { id: "t1", userMessage: { id: "u1" } },
    { id: "t2", userMessage: { id: "u2" } },
    { id: "t3", userMessage: { id: "u3" } },
  ],
}))
mockAt("../TurnGroup.tsx", () => ({
  TurnGroup: ({ turn, dimmed, dimTail }: any) =>
    createElement("div", {
      "data-testid": turn.id,
      "data-dimmed": String(Boolean(dimmed)),
      "data-dim-tail": String(Boolean(dimTail)),
    }),
}))

const { TurnList } = await import("../TurnList")
const { EditContextHost, userMessage } = await import("./editContextFixture")

const MESSAGES = [userMessage("u1", "one"), userMessage("u2", "two")]

function renderList(overrides: Record<string, unknown> = {}) {
  return render(
    createElement(
      EditContextHost,
      overrides as any,
      createElement(TurnList as any, { messages: MESSAGES }),
    ),
  )
}

describe("TurnList — dimming while editing (AC 4)", () => {
  test("nothing is dimmed when no editor is open", () => {
    const view = renderList({ editingMessageId: null })
    expect(view.getByTestId("t1").getAttribute("data-dimmed")).toBe("false")
    expect(view.getByTestId("t2").getAttribute("data-dimmed")).toBe("false")
    expect(view.queryByText(/will be replaced/)).toBeNull()
  })

  test("every turn after the edited one dims, under the divider", () => {
    const view = renderList({
      editingMessageId: "u1",
      countMessagesAfter: () => 4,
    })

    expect(view.getByTestId("t1").getAttribute("data-dimmed")).toBe("false")
    expect(view.getByTestId("t1").getAttribute("data-dim-tail")).toBe("true")
    expect(view.getByTestId("t2").getAttribute("data-dimmed")).toBe("true")
    expect(view.getByTestId("t3").getAttribute("data-dimmed")).toBe("true")
    expect(view.getByText("4 messages below will be replaced")).toBeTruthy()
  })

  test("the divider is not repeated for every dimmed turn", () => {
    const view = renderList({
      editingMessageId: "u1",
      countMessagesAfter: () => 4,
    })
    expect(view.getAllByText(/will be replaced/)).toHaveLength(1)
  })
})
