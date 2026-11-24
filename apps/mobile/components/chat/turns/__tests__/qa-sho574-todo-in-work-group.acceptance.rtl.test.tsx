// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-574 acceptance — the agent's checklist rides inside the work run.
 *
 * Renders the real stream for a real assistant message: `AssistantContent`
 * (message parts → `groupWorkParts` → `WorkGroup` → `TodoRow`), with the real
 * `ChecklistDockPanel` registered against the same per-chat stores the app
 * uses. Nothing between the message and the row is stubbed except the leaf
 * tool widgets that have nothing to do with this card.
 *
 * Locks the card's acceptance criteria:
 *   1. `read → todo → todo → edit → exec` is ONE work group, and its label
 *      counts only the real work ("Edited 1 file, ran 1 command").
 *   2. Both "Updated tasks" rows live inside that group (folded away while it
 *      is collapsed, visible when expanded), and neither renders an icon.
 *   3. A todo at the start of a turn joins the run that follows it; a turn
 *      whose only tool is `todo_write` keeps its standalone row.
 *   4. Tapping a row opens the dock's Tasks panel, which carries the LATEST
 *      snapshot — both while streaming and after the turn folds under
 *      "Worked for X".
 *   5. Phone keeps the checklist in the group's sheet and the row is inert.
 *   6. `ask_user` still splits the run exactly as before.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

const phoneState = { current: false }

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web", select: (s: any) => s.web ?? s.default },
    // `CollapsibleToolGroup` tags its bodies (`collapsible-scroll-body`,
    // `collapsible-plain-body`); the base mock renders `testID` as a
    // non-standard attribute, so map it.
    View: ({ children, testID, style: _style, onLayout: _onLayout, ...props }: any) =>
      createElement("div", { ...props, "data-testid": testID }, children as ReactNode),
    // `CollapsibleToolGroup` tags its visible body `collapsible-scroll-body`;
    // the base mock renders `testID` as a non-standard attribute, so map it.
    // RN-only props are dropped: `style` is passed as an array (React DOM
    // cannot assign it) and the rest have no DOM equivalent — same treatment
    // as `CollapsibleToolGroup.test.tsx`.
    ScrollView: ({
      children,
      testID,
      style: _style,
      onLayout: _onLayout,
      onContentSizeChange: _onContentSizeChange,
      onScrollBeginDrag: _onScrollBeginDrag,
      scrollEnabled: _scrollEnabled,
      nestedScrollEnabled: _nestedScrollEnabled,
    }: any) => createElement("div", { "data-testid": testID }, children as ReactNode),
    Pressable: ({ onPress, children, disabled, accessibilityLabel, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          disabled: !!disabled,
          onClick: disabled ? undefined : onPress,
        },
        children as ReactNode,
      ),
  }),
)

mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...a: unknown[]) => a.filter(Boolean).join(" "),
}))

// Animation shells: the card is about grouping and rows, not motion. Same
// treatment as `CollapsibleToolGroup.test.tsx`.
const MotionView = ({ children }: any) => createElement("div", null, children as ReactNode)
mock.module("@legendapp/motion", () => ({
  Motion: { View: MotionView },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
mock.module("expo-linear-gradient", () => ({ LinearGradient: () => null }))
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
}))

// The phone "Worked" sheet: renders its body only while open, so the test can
// assert the todo row is reachable from the sheet (and inert inside it).
mock.module("../../NativeActivitySheet", () => ({
  NativeActivitySheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? createElement("div", { "data-testid": "activity-sheet" }, children) : null,
  useInsideActivitySheet: () => false,
  NATIVE_ACTIVITY_LABEL: "activity-label",
  NATIVE_ACTIVITY_ROW: "activity-row",
  NATIVE_ACTIVITY_HIT_SLOP: {},
}))
mock.module("../../NativeWorkedSessionExtras", () => ({
  NativeWorkedSessionExtras: () => null,
}))
mock.module("../../../../lib/native-phone-layout", () => ({
  useIsNativePhoneLayout: () => phoneState.current,
  usePhoneLayout: () => phoneState.current,
  useNativePhoneWindow: () => ({ isPhone: phoneState.current, width: 1024, height: 768 }),
  usePhoneLayoutOverride: () => null,
}))

// Leaf tool widgets — they render the individual calls; this card is about how
// the calls are grouped. Each stub is labelled so the DOM shows what shipped.
const stub = (label: string) => (props: any) =>
  createElement("div", { "data-widget": label }, label, props.children)
mock.module("../InlineToolWidget", () => ({ InlineToolWidget: stub("inline-tool") }))
mock.module("../SubagentCard", () => ({ SubagentCard: stub("subagent") }))
mock.module("../ProjectCallCard", () => ({ ProjectCallCard: stub("project-call") }))
mock.module("../TeamCard", () => ({ TeamCard: stub("team") }))
mock.module("../ExecWidget", () => ({ ExecWidget: stub("exec") }))
mock.module("../ConnectToolWidget", () => ({
  ConnectToolWidget: stub("connect"),
  parseToolInstallResult: () => null,
}))
mock.module("../AskUserQuestionWidget", () => ({
  AskUserQuestionBar: stub("ask-bar"),
  AskUserAskedRow: stub("ask-row"),
}))
mock.module("../ToolCallGroup", () => ({ ToolCallGroup: stub("tool-group") }))
mock.module("../PlanningStatusLine", () => ({ PlanningStatusLine: stub("planning") }))
mock.module("../GenerateImageWidget", () => ({ GenerateImageWidget: stub("gen-image") }))
mock.module("../FileDeliveryWidget", () => ({ FileDeliveryWidget: stub("file-delivery") }))
mock.module("../GeneratedImageGallery", () => ({ GeneratedImageGallery: stub("gallery") }))
mock.module("../BrowserWidget", () => ({ BrowserWidget: stub("browser") }))
mock.module("../ThinkingWidget", () => ({ ThinkingWidget: stub("thinking") }))
mock.module("../WriteFileWidget", () => ({ WriteFileWidget: stub("write") }))
mock.module("../EditFileWidget", () => ({ EditFileWidget: stub("edit") }))
mock.module("../PlanReferenceCard", () => ({ PlanReferenceCard: stub("plan-card") }))
mock.module("../PublishUpgradeCard", () => ({ PublishUpgradeCard: stub("publish-upgrade") }))
mock.module("../../ChatMarkdown", () => ({
  ChatMarkdown: ({ children }: any) => createElement("p", null, children),
}))
mock.module("../../ChatContext", () => ({ useChatContextSafe: () => null }))
mock.module("../../FileViewerModal", () => ({ FileViewerModal: () => null }))
mock.module("../../ImagePreviewModal", () => ({
  ChatImageContextMenu: () => null,
  ImagePreviewModal: () => null,
}))
mock.module("../../chatImageActions", () => ({
  downloadImage: () => {},
  isShogoDesktop: () => false,
}))
mock.module("../../../../lib/agent-image-source", () => ({
  useAgentImageSource: (url: string) => ({ uri: url }),
}))
mock.module("../../../../lib/file-change-store", () => ({
  useFileChangeStore: () => ({ registerChange: () => {} }),
  classifyFileToolName: () => null,
  extractFilePath: () => null,
}))
// The panel's body is unchanged by this card; its *summary* is what proves the
// dock holds the latest checklist, and that comes straight off the store.
mock.module("../../sessionActivity", () => ({ TasksList: () => null }))

const { AssistantContent } = await import("../AssistantContent")
const { ChecklistDockPanel } = await import("../../dock/panels/ChecklistDockPanel")
const { createTodoStateStore, TodoStateStoreContext } = await import(
  "../../../../lib/todo-state-store"
)
const { createChatDockStore, ChatDockStoreContext } = await import(
  "../../../../lib/chat-dock-store"
)

type Stores = { todo: ReturnType<typeof createTodoStateStore>; dock: ReturnType<typeof createChatDockStore> }

function renderTurn(parts: any[], isStreaming: boolean, timing = true): Stores {
  const todo = createTodoStateStore()
  const dock = createChatDockStore()
  const message = {
    id: "m-sho574",
    role: "assistant",
    parts: [
      ...(timing ? [{ type: "data-turn-timing", data: { startedAt: 1_000, completedAt: 9_000 } }] : []),
      ...parts,
    ],
  }
  render(
    createElement(
      ChatDockStoreContext.Provider,
      { value: dock },
      createElement(
        TodoStateStoreContext.Provider,
        { value: todo },
        createElement(ChecklistDockPanel),
        createElement(AssistantContent, { message, isStreaming }),
      ),
    ),
  )
  return { todo, dock }
}

const tool = (toolCallId: string, toolName: string, input: any) => ({
  type: "dynamic-tool",
  toolCallId,
  toolName,
  state: "output-available",
  input,
  output: "ok",
})
const readFile = (id: string, path: string) => tool(id, "read_file", { path })
const todoWrite = (id: string, todos: Array<{ content: string; status: string }>) =>
  tool(id, "todo_write", { todos })
const editFile = (id: string, path: string) =>
  tool(id, "edit_file", { path, old_string: "a", new_string: "b" })

/** The run label is present-tense while it streams, past-tense once it settles. */
const GROUP_LABEL = /^(Editing|Edited) 1 file, ran 1 command$/
const EXPLORE_LABEL = /^(Exploring|Explored) 2 files$/
const RUN_LABEL = /^(Running|Ran) 1 command$/

/**
 * Rows inside the group's body, in order and without duplicates.
 *
 * `CollapsibleToolGroup` mounts a hidden measurer copy of its children next to
 * the visible body, and it can never measure under happy-dom, so both copies
 * stay mounted and an unscoped query sees every row twice. Identical copies are
 * collapsed by their label.
 */
function bodyRows(): HTMLElement[] {
  const rows = new Map<string, HTMLElement>()
  for (const body of screen.queryAllByTestId("collapsible-scroll-body")) {
    for (const el of within(body).queryAllByText(/^Updated tasks/)) {
      const label = el.textContent ?? ""
      if (!rows.has(label)) rows.set(label, el as HTMLElement)
    }
  }
  return [...rows.values()]
}

const firstSnapshot = [{ content: "Read the plan", status: "completed" }]
const secondSnapshot = [
  { content: "Read the plan", status: "completed" },
  { content: "Ship the fix", status: "in_progress" },
]

/** The card's exact turn: read → todo → edit → todo → exec. */
function mixedTurn() {
  return [
    readFile("r1", "apps/mobile/components/chat/turns/turnShaping.ts"),
    todoWrite("t1", firstSnapshot),
    editFile("e1", "apps/mobile/components/chat/turns/TodoRow.tsx"),
    todoWrite("t2", secondSnapshot),
    tool("x1", "exec", { command: "bun test turnShaping" }),
  ]
}

afterEach(() => {
  cleanup()
  phoneState.current = false
})

describe("SHO-574 a todo rides inside the work run", () => {
  test("read → todo → edit → todo → exec is ONE group labelled by the real work", () => {
    renderTurn(mixedTurn(), false, false)

    // Exactly one work run, and its label counts only read/edit/exec.
    const groups = screen.getAllByRole("button", { name: /^(Editing|Edited|Exploring|Explored|Running|Ran)/ })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.getAttribute("aria-label")).toMatch(GROUP_LABEL)

    // Collapsed: neither todo row leaks out beside the group.
    expect(screen.queryByText(/^Updated tasks/)).toBeNull()
    expect(screen.queryByText(/^Planning tasks/)).toBeNull()
  })

  test("both todo rows render inside the group, text only, no icon", () => {
    renderTurn(mixedTurn(), false, false)
    fireEvent.click(screen.getByRole("button", { name: GROUP_LABEL }))

    const rows = bodyRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toBe("Updated tasks · 1/1 complete")
    expect(rows[1]!.textContent).toBe("Updated tasks · 1/2 complete · 1 active")

    for (const text of rows) {
      const row = text.closest("button")
      expect(row).toBeTruthy()
      // `lucide-react-native` is stubbed to `<span data-icon>` — a re-added
      // ListTodo or planning spinner fails here.
      expect(row!.querySelector("[data-icon]")).toBeNull()
      // The row's label is its only child: no icon slot is reserved.
      expect(row!.children).toHaveLength(1)
    }
  })

  test("tapping a row inside the group opens the dock's Tasks panel with the latest snapshot", () => {
    const { dock } = renderTurn(mixedTurn(), true, false)

    const panels = dock.getPanels()
    expect(panels).toHaveLength(1)
    expect(panels[0]!.id).toBe("checklist")
    expect(panels[0]!.title).toBe("Tasks")
    // The SECOND todo_write is what the dock shows, even though both calls
    // now live inside one collapsed group.
    expect(panels[0]!.summary).toBe("1/2 complete")

    dock.closePanel("checklist")
    expect(dock.isExpanded("checklist")).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: GROUP_LABEL }))
    fireEvent.click(screen.getAllByRole("button", { name: /^Updated tasks/ })[1]!)
    expect(dock.isExpanded("checklist")).toBe(true)
  })

  test("after the turn folds under 'Worked for X' the rows are still in the group, and the dock still has the checklist", () => {
    const { dock, todo } = renderTurn(
      [...mixedTurn(), { type: "text", text: "Done — the todo rides along now." }],
      false,
    )

    // The work log folded: the group is not on screen until "Worked for" opens.
    expect(screen.getByText(/^Worked for 8s$/)).toBeTruthy()
    expect(screen.queryByText(/^Updated tasks/)).toBeNull()
    // The dock kept the latest checklist across the fold.
    expect(dock.getPanels()[0]!.summary).toBe("1/2 complete")
    expect(todo.getLatest().map((t) => t.content)).toEqual(["Read the plan", "Ship the fix"])

    fireEvent.click(screen.getByText(/^Worked for 8s$/).closest("button")!)
    const workedLog = within(screen.getByTestId("collapsible-plain-body"))
    fireEvent.click(workedLog.getByRole("button", { name: GROUP_LABEL }))
    expect(bodyRows()).toHaveLength(2)

    dock.closePanel("checklist")
    fireEvent.click(bodyRows()[0]!.closest("button")!)
    expect(dock.isExpanded("checklist")).toBe(true)
  })

  test("a todo at the start of a turn joins the run that follows it", () => {
    renderTurn([todoWrite("t1", firstSnapshot), readFile("r1", "a.ts"), readFile("r2", "b.ts")], false, false)

    const groups = screen.getAllByRole("button", { name: /^(Editing|Edited|Exploring|Explored)/ })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.getAttribute("aria-label")).toMatch(EXPLORE_LABEL)
    expect(screen.queryByText(/^Updated tasks/)).toBeNull()

    fireEvent.click(groups[0]!)
    expect(bodyRows()).toHaveLength(1)
  })

  test("a turn whose only tool is todo_write keeps its standalone row", () => {
    const { dock } = renderTurn([todoWrite("t1", secondSnapshot)], false, false)

    const row = screen.getByRole("button", { name: /^Updated tasks/ })
    expect(row.textContent).toBe("Updated tasks · 1/2 complete · 1 active")
    expect(row.querySelector("[data-icon]")).toBeNull()
    // Still a pointer to the panel, not the checklist itself.
    expect(dock.getPanels()[0]!.summary).toBe("1/2 complete")
    dock.closePanel("checklist")
    fireEvent.click(row)
    expect(dock.isExpanded("checklist")).toBe(true)
  })

  test("ask_user still splits the run exactly as before", () => {
    renderTurn(
      [
        readFile("r1", "a.ts"),
        todoWrite("t1", firstSnapshot),
        tool("a1", "ask_user", { questions: [] }),
        tool("x1", "exec", { command: "ls" }),
      ],
      false,
      false,
    )

    // Two runs with the question between them, and the todo did not swallow
    // the split: it belongs to the run that just happened.
    const groups = screen.getAllByRole("button", { name: /^(Editing|Edited|Exploring|Explored|Running|Ran)/ })
    expect(groups).toHaveLength(2)
    expect(groups[0]!.getAttribute("aria-label")).toMatch(/^(Exploring|Explored) 1 file$/)
    expect(groups[1]!.getAttribute("aria-label")).toMatch(RUN_LABEL)
    // The question keeps its own row between the two runs (bar or asked row,
    // depending on how the answer streamed).
    expect(screen.getByText(/^ask-(bar|row)$/)).toBeTruthy()
    expect(screen.queryByText(/^Updated tasks/)).toBeNull()
    fireEvent.click(groups[0]!)
    expect(bodyRows()).toHaveLength(1)
  })

  test("on phone the todo row lives in the group's sheet and is inert", () => {
    phoneState.current = true
    const { dock } = renderTurn(mixedTurn(), true, false)

    // No dock Needs-panel on phone (the Worked sheet is the checklist home).
    expect(dock.getPanels()).toHaveLength(0)
    expect(screen.queryByText(/^Updated tasks/)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: GROUP_LABEL }))
    const sheet = screen.getByTestId("activity-sheet")
    const rows = within(sheet).getAllByText(/^Updated tasks/)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.closest("button")!.querySelector("[data-icon]")).toBeNull()
    expect(rows[0]!.closest("button")!.disabled).toBe(true)
    fireEvent.click(rows[0]!.closest("button")!)
    expect(dock.isExpanded("checklist")).toBe(false)
  })
})
