// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduces `ChatPanel`'s exact wiring for the pending-`ask_user` blocking
 * dock panel: `useDockPanel({ kind: "blocking", ... }, chatDockStore)`
 * feeding `AskUserQuestionWidget` into `<ChatDock>`, rendered through the
 * REAL `chat-dock-store.ts` / `useDockPanel.ts` / `ChatDock.tsx` /
 * `DockPanel.tsx` — only leaf platform modules (`react-native` primitives,
 * `@legendapp/motion`, `expo-linear-gradient`,
 * `@react-native-async-storage/async-storage`, `@shogo/shared-ui/primitives`)
 * are stubbed.
 *
 * User report: "the questions are not showing up" — a pending `ask_user`
 * tool call updates the composer placeholder ("Respond to the question
 * below…") but no card appeared above the composer.
 *
 * ROOT CAUSE (found via this test, which reproduced the bug before the fix
 * below): `ChatPanel` calls `useDockPanel(questionDockDescriptor)` directly
 * in its OWN function body — a component can't `useContext` its own
 * `<ChatDockStoreContext.Provider>`, since Providers only affect
 * *descendants*, not the component instantiating them. That call silently
 * registered against the shared `getFallbackStore()` singleton instead of
 * the real per-`ChatPanel` store `<ChatDock>` actually renders from, so the
 * "Question" panel never appeared. Same bug hit all five of `ChatPanel`'s
 * inline blocking/status descriptors (permission, question, connectivity,
 * tool-error, error) — see `useDockPanel`'s doc comment for the fix
 * (`storeOverride`, passed as `chatDockStore` from all five call sites).
 * The other dock panels (`PlanDockPanel`, `ChangesDockPanel`, …) were never
 * affected: they're separate components rendered as JSX children INSIDE
 * the Provider, so their own `useContext` call correctly sees it.
 */
import { describe, expect, mock, test } from "bun:test"
import { act, render, screen } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

// This directory resolves the bare `react-native` specifier to a different
// physical copy (bun's content-hashed peer-dep duplication) than the one
// `test/testing-library.ts`'s global preload keys its mock to, so without a
// per-file override here the REAL `react-native/index.js` loads and throws
// on its Flow syntax. Every other RTL file in this app carries the same
// override for the same reason — see `CollapsibleToolGroup.test.tsx`.
mock.module("react-native", () => createReactNativeMock())

// Icons come from the shared `lucide-react-native` stub that
// `test/testing-library.ts` preloads process-wide — deliberately NOT
// re-mocked here (a per-file override would narrow it for every other test
// file sharing this bun test process; see `ChatInput.max-update-depth-repro
// .test.tsx`'s header comment on the same point).

// `useAskUserQuestionDraft` hydrates from AsyncStorage on mount — stub it
// with an in-memory backing store so the widget doesn't hit real storage.
const asyncStorageBacking = new Map<string, string>()
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => asyncStorageBacking.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      asyncStorageBacking.set(k, v)
    },
    removeItem: async (k: string) => {
      asyncStorageBacking.delete(k)
    },
  },
}))

// Inert passthroughs — this file asserts on DOM content, not animation
// timing (same convention as `CollapsibleToolGroup.test.tsx`).
mock.module("@legendapp/motion", () => ({
  Motion: {
    View: React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionView(
      { children },
      ref,
    ) {
      return React.createElement("div", { ref }, children as React.ReactNode)
    }),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))
mock.module("expo-linear-gradient", () => ({
  LinearGradient: () => null,
}))

// `@shogo/shared-ui/primitives`'s `index.ts` re-exports several RN-backed
// components (`Switch`, `Button`, …) that pull in yet another physical
// `react-native` copy from deep inside `packages/shared-ui` — narrow this
// down to just the `cn` helper the code under test actually uses.
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

// All mocks above MUST be registered before the real modules under test are
// imported — see `TurnFooter.test.tsx` for why this has to be a dynamic
// import rather than a static top-level one.
const { createChatDockStore, ChatDockStoreContext } = await import("../../../../lib/chat-dock-store")
const { useDockPanel } = await import("../useDockPanel")
const { ChatDock } = await import("../ChatDock")
const { AskUserQuestionWidget } = await import("../../turns/AskUserQuestionWidget")
const toolTypes = await import("../../tools/types")

// `DockPanelDescriptor.icon` just needs to be a component; no need to pull
// in a real lucide icon (see note above on not re-mocking that module).
function DummyIcon() {
  return null
}

function PendingQuestionHarness() {
  const store = React.useMemo(() => createChatDockStore(), [])

  // Mirrors `ChatPanel`'s `questionDockDescriptor` verbatim: `kind:
  // "blocking"`, `order: 1`, title "Question", rendering
  // `AskUserQuestionWidget` for a still-pending (no `result`) tool call.
  const descriptor = React.useMemo(
    () => ({
      id: "question",
      kind: "blocking" as const,
      order: 1,
      title: "Question",
      icon: DummyIcon,
      render: ({ bodyMaxHeight }) => (
        <AskUserQuestionWidget
          tool={{
            id: "call-abc",
            toolName: "ask_user",
            category: toolTypes.getToolCategory("ask_user"),
            state: "input-available" as never,
            args: {
              questions: [
                {
                  header: "Nav trigger",
                  question: "Which orb should be the nav trigger?",
                  options: [
                    { label: "Merged hub orb", description: "" },
                    { label: "Separate mic button", description: "" },
                  ],
                },
              ],
            },
            result: undefined,
            timestamp: 0,
          }}
          onSubmitResponse={() => {}}
          embedded
          bodyMaxHeight={bodyMaxHeight}
        />
      ),
    }),
    [],
  )

  // Mirrors `ChatPanel`'s fix: this component renders its OWN
  // `<ChatDockStoreContext.Provider>` below, so it must pass `store`
  // explicitly here rather than relying on `useContext` (which would only
  // see an ANCESTOR's Provider, not this one). Dropping the second
  // argument reproduces the original bug — the panel silently registers
  // against the fallback store instead and the assertions below fail.
  useDockPanel(descriptor, store)

  return (
    <ChatDockStoreContext.Provider value={store}>
      <ChatDock />
    </ChatDockStoreContext.Provider>
  )
}

describe("ChatDock renders a pending ask_user as a blocking panel", () => {
  test("the 'Question' panel and its question text are visible", async () => {
    render(<PendingQuestionHarness />)
    // Let `useAskUserQuestionDraft`'s AsyncStorage hydration effect settle
    // before asserting, so React doesn't warn about an unwrapped update.
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText("Question")).toBeTruthy()
    expect(screen.queryByText("Questions")).toBeNull()
    expect(screen.getByText("Which orb should be the nav trigger?")).toBeTruthy()
    // Renders twice (label + description fallback, since our fixture's
    // options have no description) — assert presence, not uniqueness.
    expect(screen.getAllByText("Merged hub orb").length).toBeGreaterThan(0)
  })
})
