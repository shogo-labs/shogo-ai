// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "Rejoining live reply…" row is a shimmer, not a dot loader (SHO-366).
 *
 * Locks:
 *   - the row's words spell "Rejoining live reply…" one character per span, in
 *     the same shimmer as "Planning next moves" — so no bouncing dots (the
 *     `rounded-full` motion views SHO-297 drew) survive in it;
 *   - the row keeps `testID="chat-rejoining-row"` and `aria-busy`, which the
 *     e2e specs and the give-up paths look for;
 *   - on a native phone it shares the 15px activity scale with the rest of the
 *     activity rows.
 */
import { resolve } from "node:path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

let phoneLayout = false

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
  }),
)

mock.module("../../../../lib/native-phone-layout", () => ({
  useIsNativePhoneLayout: () => phoneLayout,
  usePhoneLayout: () => phoneLayout,
  useNativePhoneWindow: () => ({ isPhone: phoneLayout, width: 390, height: 844 }),
  isNativePhoneIntegrationsLayout: () => phoneLayout,
  nativePhoneFillStyle: (width: number) => ({ width }),
  nativeContentWidth: (windowWidth: number, pad = 32) => Math.max(0, windowWidth - pad),
  NATIVE_PHONE_SHEET_ACTIVITY_BODY_RATIO: 0.56,
  NATIVE_PHONE_SHEET_COMPACT_RATIO: 0.72,
  NATIVE_PHONE_GUTTER: 16,
}))

const NATIVE_ACTIVITY_LABEL = "text-[15px] leading-5 text-muted-foreground"
const NATIVE_ACTIVITY_ROW = "py-0.5"

mock.module(resolve(import.meta.dir, "../../NativeActivitySheet"), () => ({
  NativeActivitySheet: () => null,
  useInsideActivitySheet: () => false,
  NATIVE_ACTIVITY_LABEL,
  NATIVE_ACTIVITY_ROW,
  NATIVE_ACTIVITY_HIT_SLOP: { top: 12, bottom: 12, left: 8, right: 8 },
}))
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

const { RejoinRow } = await import("../RejoinRow")

afterEach(cleanup)

/** The row's row: the element carrying the rejoin testID. */
function row(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-rn-shim="chat-rejoining-row"]')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

describe("the rejoin row", () => {
  test("spells its words as a per-character shimmer", () => {
    phoneLayout = false
    const { container } = render(<RejoinRow />)

    const chars = Array.from(row(container).querySelectorAll("span")).map(
      (el) => el.textContent,
    )
    // Every space is rendered as a non-breaking space so the row cannot wrap.
    expect(chars.join("").replace(/\u00A0/g, " ")).toBe("Rejoining live reply…")
    expect(chars.length).toBe("Rejoining live reply…".length)
  })

  test("has no bouncing dots", () => {
    phoneLayout = false
    const { container } = render(<RejoinRow />)

    // SHO-297's loader was three `rounded-full` motion views.
    expect(row(container).querySelectorAll(".rounded-full").length).toBe(0)
    expect(container.querySelectorAll('[data-rn-shim="chat-rejoining-row"]').length).toBe(1)
  })

  test("stays identifiable and busy for the e2e specs", () => {
    phoneLayout = false
    const { container } = render(<RejoinRow />)

    expect(row(container).getAttribute("aria-busy")).toBe("true")
  })

  test("desktop characters use the 12px muted style", () => {
    phoneLayout = false
    const { container } = render(<RejoinRow />)

    const [first] = Array.from(row(container).querySelectorAll("span"))
    expect(first.className).toBe("text-xs text-muted-foreground")
  })

  test("on a native phone it joins the 15px activity scale", () => {
    phoneLayout = true
    const { container } = render(<RejoinRow />)

    const spans = Array.from(row(container).querySelectorAll("span"))
    expect(spans.length).toBeGreaterThan(1)
    expect(spans.every((el) => el.className === NATIVE_ACTIVITY_LABEL)).toBe(true)
    expect(row(container).className).toBe(NATIVE_ACTIVITY_ROW)
    phoneLayout = false
  })
})
