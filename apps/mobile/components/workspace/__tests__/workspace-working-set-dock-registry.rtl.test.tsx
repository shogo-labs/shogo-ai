// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Working set's dock body must follow the state its chips show (SHO-484).
 *
 * QA found the regression in a browser: `panelsObservablyEqual` deliberately
 * ignores `render`, and nothing in the descriptor's *observable* fields moves
 * when the side pane opens or closes — so `registerPanel` stored the fresh
 * closure without notifying, `ChatDock` kept painting the previous body, and
 * the chip stayed `aria-selected="true"` over a closed pane with a dead handler.
 *
 * Both working-set suites render the descriptor straight into a stand-in dock,
 * which cannot see that: they never go through the registry. This does — a real
 * `ChatDockStore`, a dock that renders whatever the store holds at the current
 * version (exactly what `ChatDock` does), and a host that mirrors the screen:
 * pane state, `useWorkingSetRevision`, `buildWorkingSetDockPanel` and
 * `useHostDockPanels`. Without a revision that tracks the body, the first press
 * never reaches the body and this fails.
 */
import { afterEach, expect, mock, test } from "bun:test"
import {
  createElement,
  forwardRef,
  useState,
  useSyncExternalStore,
} from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"
import {
  createChatDockStore,
  type ChatDockStore,
} from "../../../lib/chat-dock-store"
import { useHostDockPanels } from "../../chat/dock/useDockPanel"

/**
 * `react-native`'s mock does not forward a Pressable's `onPress` to the host, so
 * these hosts publish what a press and a selection look like in the DOM.
 */
const pressable = forwardRef(function Pressable(props: any, ref: any) {
  const { accessibilityLabel, onPress, testID, className, children } = props
  return createElement(
    "button",
    {
      ref,
      "aria-label": accessibilityLabel,
      "aria-selected": props["aria-selected"],
      "data-testid": testID,
      type: "button",
      className,
      onClick: onPress,
    },
    children,
  )
})

const host = (tag: string) => (props: any) => {
  const { testID, accessibilityLabel, children, className } = props
  return createElement(
    tag,
    { "data-testid": testID, "aria-label": accessibilityLabel, className },
    children,
  )
}

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
    Pressable: pressable,
    View: host("div"),
    Text: host("span"),
    ScrollView: host("div"),
  } as any),
)

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
)
const { buildWorkingSetDockPanel, useWorkingSetRevision } = await import(
  "../WorkingSetDockPanel"
)

const ATTACHMENTS = [
  { id: "att-a", projectId: "proj-a" },
  { id: "att-b", projectId: "proj-b" },
]
const NAMES: Record<string, string> = { "proj-a": "Alpha", "proj-b": "Beta" }

/** What `ChatDock` does: render whatever the registry holds at this version. */
function RegistryDock({ store }: { store: ChatDockStore }) {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return createElement(
    "div",
    null,
    ...store.getPanels().map((panel) =>
      createElement(
        "div",
        { key: panel.id, "data-testid": `dock-body-${panel.id}` },
        panel.render({ expanded: true }),
      ),
    ),
  )
}

/**
 * The screen's half of the panel: the pane it shows, the revision that tracks
 * the chips, the descriptor, and registration through the real `ChatPanel` hook.
 */
function Host({ store }: { store: ChatDockStore }) {
  const [paneProjectId, setPaneProjectId] = useState<string | null>(null)
  const revision = useWorkingSetRevision({
    attachments: ATTACHMENTS,
    focusedProjectId: "proj-a",
    hasSidePane: true,
    paneProjectId,
  })
  const descriptor = buildWorkingSetDockPanel({
    attachments: ATTACHMENTS,
    focusedProjectId: "proj-a",
    projectName: (projectId) => NAMES[projectId] ?? projectId,
    hasSidePane: true,
    paneProjectId,
    // Reads the pane from this render's closure, like `pressWorkingSetChip`.
    onPressChip: (projectId) =>
      setPaneProjectId(paneProjectId === projectId ? null : projectId),
    onManage: () => {},
    revision,
  })
  useHostDockPanels([descriptor], store)

  return createElement(
    "div",
    null,
    createElement(RegistryDock, { store }),
    createElement("span", { "data-testid": "pane" }, paneProjectId ?? "none"),
  )
}

const chip = (name: string) => screen.getByLabelText(`${name} project`)
const pane = () => screen.getByTestId("pane").textContent

const openHost = async (store: ChatDockStore) => {
  render(createElement(Host, { store }))
  await waitFor(() =>
    expect(screen.getByTestId("dock-body-working-set")).toBeInTheDocument(),
  )
}

test("the chip follows the pane it opens, closes it again, and still works", async () => {
  const store = createChatDockStore()
  await openHost(store)

  expect(chip("Alpha").getAttribute("aria-selected")).toBe("false")

  // Press 1 opens the project beside the chat; the body has to repaint from the
  // descriptor registered for *this* state, not the one from before the press.
  fireEvent.click(chip("Alpha"))
  await waitFor(() => expect(pane()).toBe("proj-a"))
  await waitFor(() =>
    expect(chip("Alpha").getAttribute("aria-selected")).toBe("true"),
  )

  // Press 2 closes it — the pane flag is what the closure reads, so a stale
  // body would open the pane again instead.
  fireEvent.click(chip("Alpha"))
  await waitFor(() => expect(pane()).toBe("none"))
  await waitFor(() =>
    expect(chip("Alpha").getAttribute("aria-selected")).toBe("false"),
  )

  // Press 3: the handler is alive, not a leftover from the first body.
  fireEvent.click(chip("Alpha"))
  await waitFor(() => expect(pane()).toBe("proj-a"))
  await waitFor(() =>
    expect(chip("Alpha").getAttribute("aria-selected")).toBe("true"),
  )
})

test("swapping to the other project selects its chip and clears the first", async () => {
  const store = createChatDockStore()
  await openHost(store)

  fireEvent.click(chip("Alpha"))
  await waitFor(() => expect(pane()).toBe("proj-a"))

  fireEvent.click(chip("Beta"))
  await waitFor(() => expect(pane()).toBe("proj-b"))
  await waitFor(() =>
    expect(chip("Beta").getAttribute("aria-selected")).toBe("true"),
  )
  expect(chip("Alpha").getAttribute("aria-selected")).toBe("false")
})

afterEach(() => cleanup())
