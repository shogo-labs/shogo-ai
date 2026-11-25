// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-480 — the web hover info card must sit beside the row it describes.
 *
 * The card used to be placed at `rowIndex * 32`, which guessed the row height
 * (a web row is ~36px) and ignored the list's scroll offset entirely, so after
 * scrolling the card sat below the hovered row and eventually past the bottom
 * of the menu. These tests drive the real component with measured geometry:
 * `onLayout` on the rows, `onLayout` on the list viewport and the card, and
 * `onScroll` with a `contentOffset.y`.
 *
 * `onLayout` / `onScroll` are not DOM events, so the shims here keep the
 * handlers and the tests call them — the same pattern the team-chat and
 * message-sizing suites use.
 */
import { describe, expect, mock, test } from "bun:test"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const layoutHandlers = new WeakMap<Element, (event: unknown) => void>()
const scrollHandlers = new WeakMap<Element, (event: unknown) => void>()
const platformOverride = { OS: "web" }

function ViewShim({ children, onLayout, onMouseEnter, onMouseLeave, testID, className, style }: any) {
  return createElement(
    "div",
    {
      "data-testid": testID,
      className,
      style,
      onMouseEnter,
      onMouseLeave,
      ref: (node: HTMLElement | null) => {
        if (node && typeof onLayout === "function") layoutHandlers.set(node, onLayout)
      },
    },
    children,
  )
}

function ScrollViewShim({ children, onLayout, onScroll, testID, className, style }: any) {
  return createElement(
    "div",
    {
      "data-testid": testID,
      className,
      style,
      ref: (node: HTMLElement | null) => {
        if (!node) return
        if (typeof onLayout === "function") layoutHandlers.set(node, onLayout)
        if (typeof onScroll === "function") scrollHandlers.set(node, onScroll)
      },
    },
    children,
  )
}

/** The web row is a `Pressable` whose hover is an `onHoverIn` / `onHoverOut`. */
function PressableShim({
  children,
  onPress,
  onHoverIn,
  onHoverOut,
  testID,
  className,
  style,
  disabled,
}: any) {
  const tag = mockPlatform.OS === "web" ? "button" : "div"
  return createElement(
    tag,
    {
      "data-testid": testID,
      className,
      style,
      disabled,
      onClick: onPress,
      onMouseEnter: onHoverIn,
      onMouseLeave: onHoverOut,
    },
    children,
  )
}

const MODELS = Array.from({ length: 12 }, (_, index) => ({
  id: `model-${index}`,
  displayName: `Model ${index}`,
  shortDisplayName: `M${index}`,
  tier: "standard" as const,
  description: `Description for model ${index}`,
  contextWindow: 200_000,
  ...(index < 2 ? { reasoningEfforts: ["low", "high"] as const } : {}),
}))

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: platformOverride,
    View: ViewShim,
    ScrollView: ScrollViewShim,
    Pressable: PressableShim,
  }),
)
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}))
mock.module("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }))
mock.module("@/lib/billing-config", () => ({ UPGRADE_PLAN_NAME: "Business" }))
mock.module("../../../lib/native-phone-layout", () => ({
  NATIVE_PHONE_SECTION_INSET: 16,
  isNativePlatform: () => false,
}))
mock.module("@/components/ui/popover", () => ({
  Popover: () => null,
  PopoverBackdrop: () => null,
  PopoverContent: () => null,
}))
mock.module("../NativeActivitySheet", () => ({ NativeActivitySheet: () => null }))
mock.module("../../../lib/use-is-super-admin", () => ({ useIsSuperAdmin: () => false }))
mock.module("../../layout/MobileWorkspaceChromeContext", () => ({
  useMobileWorkspaceChrome: () => false,
}))
mock.module("../../../lib/visible-models", () => ({ useModelPickerList: () => MODELS }))

const { Platform: mockPlatform } = await import("react-native") as { Platform: { OS: string } }
const { ModelPickerMenu } = await import("../ModelPickerMenu")

/** One web row: `py-2` + `text-sm` lands on 36px, not the old 32px guess. */
const ROW_HEIGHT = 36
/** The Auto row (36) plus the 1px divider come before the first model row. */
const FIRST_ROW_Y = 37
const VIEWPORT_HEIGHT = 340
const CARD_HEIGHT = 120

const rowY = (index: number) => FIRST_ROW_Y + index * ROW_HEIGHT

function fireLayout(element: Element, y: number, height: number) {
  const handler = layoutHandlers.get(element)
  if (!handler) throw new Error("no onLayout registered on this element")
  act(() => handler({ nativeEvent: { layout: { x: 0, y, width: 280, height } } }))
}

function fireScroll(y: number) {
  const list = screen.getByTestId("model-picker-scroll")
  const handler = scrollHandlers.get(list)
  if (!handler) throw new Error("the web list registered no onScroll")
  act(() =>
    handler({
      nativeEvent: {
        contentOffset: { x: 0, y },
        contentSize: { width: 280, height: FIRST_ROW_Y + MODELS.length * ROW_HEIGHT },
        layoutMeasurement: { width: 280, height: VIEWPORT_HEIGHT },
      },
    }),
  )
}

/** Lay out the list, every row, then the card — the order the browser uses. */
function measure(renderResult: ReturnType<typeof render>) {
  fireLayout(screen.getByTestId("model-picker-scroll"), 0, VIEWPORT_HEIGHT)
  MODELS.forEach((model, index) => {
    const row = renderResult.getByTestId(`model-option-${model.id}`)
    fireLayout(row.parentElement as Element, rowY(index), ROW_HEIGHT)
  })
}

function hover(modelIndex: number) {
  fireEvent.mouseEnter(screen.getByTestId(`model-option-${MODELS[modelIndex].id}`))
}

function cardTop(): number {
  const card = screen.getByTestId("model-info-card")
  return Math.round(parseFloat((card as HTMLElement).style.top))
}

function renderMenu(props: Record<string, unknown> = {}) {
  const result = render(
    createElement(ModelPickerMenu, {
      currentModelId: MODELS[0].id,
      effectiveIsPro: true,
      onSelect: () => {},
      ...props,
    }),
  )
  measure(result)
  return result
}

describe("ModelPickerMenu web hover card (SHO-480)", () => {
  test("an unscrolled list puts the card's top on the hovered row", () => {
    renderMenu()
    hover(3)
    expect(cardTop()).toBe(rowY(3))
    // The composer picker is anchored to the viewport's right edge, so the
    // effort panel must open left of the list rather than off-screen.
    const card = screen.getByTestId("model-info-card") as HTMLElement
    expect(card.style.right).toBe("100%")
    expect(card.style.marginRight).toBe("8px")

    hover(7)
    expect(cardTop()).toBe(rowY(7))
  })

  test("scrolling moves the card with the row instead of leaving it behind", () => {
    renderMenu()
    fireScroll(200)
    hover(6)
    // The row is at 253 in the content; 200 of that has scrolled away.
    expect(cardTop()).toBe(rowY(6) - 200)

    // A row that has scrolled partly past the top pins the card to the top of
    // the list rather than letting it start above it.
    fireScroll(260)
    hover(6)
    expect(cardTop()).toBe(0)

    // A row still fully inside the viewport keeps its own offset.
    hover(8)
    expect(cardTop()).toBe(rowY(8) - 260)
  })

  test("the card stays inside the menu at the bottom of the list", () => {
    renderMenu()
    const maxScroll = FIRST_ROW_Y + MODELS.length * ROW_HEIGHT - VIEWPORT_HEIGHT
    fireScroll(maxScroll)
    hover(MODELS.length - 1)

    // The card is measured once it paints; its own height is what bounds it.
    const card = screen.getByTestId("model-info-card")
    fireLayout(card, 0, CARD_HEIGHT)

    const top = cardTop()
    expect(top).toBe(VIEWPORT_HEIGHT - CARD_HEIGHT)
    expect(top + CARD_HEIGHT).toBeLessThanOrEqual(VIEWPORT_HEIGHT)
    // ...and the row it belongs to is on screen, under the card's top edge.
    expect(rowY(MODELS.length - 1) - maxScroll).toBeGreaterThan(top)
    expect(rowY(MODELS.length - 1) - maxScroll).toBeLessThan(top + CARD_HEIGHT)
  })

  test("a hovered row scrolled out of the viewport shows no card", () => {
    renderMenu()
    hover(1)
    expect(screen.getByTestId("model-info-card")).toBeTruthy()

    // Row 1 ends at 109, so 200px of scroll leaves none of it to sit beside.
    fireScroll(200)
    expect(screen.queryByTestId("model-info-card")).toBeNull()

    // Scrolling back brings it back beside the same row.
    fireScroll(0)
    expect(cardTop()).toBe(rowY(1))
  })

  test("a card taller than the list still never starts above the list", () => {
    renderMenu()
    hover(2)
    fireLayout(screen.getByTestId("model-info-card"), 0, VIEWPORT_HEIGHT + 40)
    expect(cardTop()).toBe(0)
  })

  test("model details do not contain the separate effort control", () => {
    renderMenu()
    hover(0)
    expect(screen.getByTestId("model-info-card")).toBeTruthy()
    expect(screen.queryByTestId("reasoning-effort-model-0-low")).toBeNull()
  })

  test("names-only pickers show no card at all", () => {
    renderMenu({ hideCostLabels: true })
    hover(2)
    expect(screen.queryByTestId("model-info-card")).toBeNull()
  })

})
