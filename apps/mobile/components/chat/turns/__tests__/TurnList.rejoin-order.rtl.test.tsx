// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-366 AC 1 — a chat that reopens mid-turn keeps the reply received so far
 * on screen and draws "Rejoining live reply…" **under** it, as the last thing
 * in the transcript.
 *
 * The pure helper (`rejoin-view.test.ts`) proves the transcript passes through
 * untouched; this locks the composition: TurnList must draw the turns it was
 * given and put the row after the last one, so a future "draw the row instead
 * of the tail" regression fails here instead of only in the e2e lane.
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
mock.module("expo-router", () => ({
  useRouter: () => ({ push: () => {} }),
}))
mockAt("../../../../lib/native-phone-layout", () => ({
  useIsNativePhoneLayout: () => false,
  usePhoneLayout: () => false,
}))
mockAt("../../NativeActivitySheet", () => ({
  NativeActivitySheet: () => null,
  useInsideActivitySheet: () => false,
  NATIVE_ACTIVITY_LABEL: "text-[15px] leading-5 text-muted-foreground",
  NATIVE_ACTIVITY_ROW: "py-0.5",
  NATIVE_ACTIVITY_HIT_SLOP: { top: 12, bottom: 12, left: 8, right: 8 },
}))

const HALF_WRITTEN = "half-written reply"
const TURNS = [
  { id: "t1", userMessage: { id: "u1" } },
  { id: "t2", userMessage: { id: "u2" } },
]

mockAt("../useTurnGrouping.ts", () => ({ useTurnGrouping: () => TURNS }))
mockAt("../TurnGroup.tsx", () => ({
  TurnGroup: ({ turn, rejoining }: any) =>
    createElement(
      "div",
      { "data-testid": turn.id, "data-rejoining": String(Boolean(rejoining)) },
      turn.id === "t2" ? HALF_WRITTEN : "first turn",
    ),
}))

const { TurnList } = await import("../TurnList")

const MESSAGES = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "one" }] },
  { id: "u2", role: "user", parts: [{ type: "text", text: "two" }] },
] as any

function renderList(props: Record<string, unknown> = {}) {
  return render(
    createElement(TurnList as any, { messages: MESSAGES, ...props }),
  )
}

describe("TurnList — the rejoin row sits under the reply so far (SHO-366)", () => {
  test("the half-written reply is on screen with the row after it", () => {
    const view = renderList({ rejoining: true })

    expect(view.getByText(HALF_WRITTEN)).toBeTruthy()

    // This file's View mock spreads props onto a div, so `testID` lands as `testid`.
    const list = view.container.querySelector('[testid="turn-list"]')!
    const reply = view.getByText(HALF_WRITTEN)
    const row = view.container.querySelector('[testid="chat-rejoining-row"]')!
    // DOCUMENT_POSITION_FOLLOWING (4): the row comes after the reply.
    const all = Array.from(list.querySelectorAll<HTMLElement>("*"))
    expect(all.indexOf(reply), "the reply is inside the list").toBeGreaterThan(-1)
    expect(
      all.indexOf(row),
      "the row comes after the reply received so far",
    ).toBeGreaterThan(all.indexOf(reply))
    // …and it is the last thing in the transcript.
    const children = Array.from(list.children)
    expect(children[children.length - 1]).toBe(row)
  })

  test("only the live turn is told it is rejoining, so its dots stay off", () => {
    const view = renderList({ rejoining: true })
    expect(view.getByTestId("t1").getAttribute("data-rejoining")).toBe("false")
    expect(view.getByTestId("t2").getAttribute("data-rejoining")).toBe("true")
  })

  test("no row once the window attached", () => {
    const view = renderList({ rejoining: false })
    expect(
      view.container.querySelector('[testid="chat-rejoining-row"]'),
    ).toBeNull()
    expect(view.getByText(HALF_WRITTEN)).toBeTruthy()
  })
})
