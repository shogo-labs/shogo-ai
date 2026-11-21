// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `ChatPanel`'s `dockPanels` prop (SHO-484): a host screen — the workspace
 * agent's chat — hands the panel a "Working set" descriptor and the panel puts
 * it in the chat dock. The subtle part is the session switch: `ChatPanel` calls
 * `chatDockStore.reset()` whenever the chat session changes, which drops every
 * registration, so the host's panels have to be put back in the same commit.
 *
 * This mounts the two effects in the order `ChatPanel` declares them — reset
 * first, host panels second — because that ordering is what makes the
 * re-registration happen, and asserts the panel survives the switch.
 */
import { afterEach, expect, test } from "bun:test"
import { createElement, useEffect } from "react"
import { FolderKanban } from "lucide-react-native"
import {
  createChatDockStore,
  type ChatDockStore,
  type DockPanelDescriptor,
} from "../../../../lib/chat-dock-store"
import { useHostDockPanels } from "../useDockPanel"

const { cleanup, render } = await import("@testing-library/react")

const WORKING_SET: DockPanelDescriptor = {
  id: "working-set",
  kind: "status",
  order: 5,
  title: "Working set",
  icon: FolderKanban,
  summary: "Alpha +1",
  defaultExpanded: false,
  render: () => null,
}

/**
 * The part of `ChatPanelContent` this test is about: the session-change reset
 * declared first, the host's panels registered immediately after it.
 */
function Host({
  store,
  sessionId,
  panels,
}: {
  store: ChatDockStore
  sessionId: string
  panels: DockPanelDescriptor[]
}) {
  useEffect(() => {
    store.reset()
  }, [sessionId, store])
  useHostDockPanels(panels, store)
  return null
}

const ids = (store: ChatDockStore) => store.getPanels().map((panel) => panel.id)

test("a descriptor handed to the panel is registered in the dock", () => {
  const store = createChatDockStore()
  render(createElement(Host, { store, sessionId: "s-1", panels: [WORKING_SET] }))

  expect(ids(store)).toEqual(["working-set"])
  expect(store.getPanels()[0]?.summary).toBe("Alpha +1")
})

test("the panel is still registered after the chat session changes", () => {
  const store = createChatDockStore()
  const { rerender } = render(
    createElement(Host, { store, sessionId: "s-1", panels: [WORKING_SET] }),
  )
  expect(ids(store)).toEqual(["working-set"])

  rerender(createElement(Host, { store, sessionId: "s-2", panels: [WORKING_SET] }))

  // The reset ran (it clears the registry) and the host's panel came straight
  // back, so switching chats keeps the Working set.
  expect(ids(store)).toEqual(["working-set"])
})

test("dropping the descriptor from the prop removes the panel", () => {
  const store = createChatDockStore()
  const { rerender } = render(
    createElement(Host, { store, sessionId: "s-1", panels: [WORKING_SET] }),
  )
  expect(ids(store)).toEqual(["working-set"])

  // The last project was detached: the screen stops passing the descriptor.
  rerender(createElement(Host, { store, sessionId: "s-1", panels: [] }))

  expect(ids(store)).toEqual([])
})

test("an updated descriptor replaces the one in the dock without losing state", () => {
  const store = createChatDockStore()
  const { rerender } = render(
    createElement(Host, { store, sessionId: "s-1", panels: [WORKING_SET] }),
  )

  rerender(
    createElement(Host, {
      store,
      sessionId: "s-1",
      panels: [{ ...WORKING_SET, summary: "Beta" }],
    }),
  )

  expect(store.getPanels()[0]?.summary).toBe("Beta")
})

afterEach(() => cleanup())
