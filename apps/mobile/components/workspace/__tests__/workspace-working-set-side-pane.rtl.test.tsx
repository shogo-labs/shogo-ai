// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace agent's Working set opens a project beside the chat, the way a
 * thread's agent does (SHO-427).
 *
 * A chip used to only open the scope sheet, whose Open button pushed the full
 * project page — so the chat unmounted and the turn on screen was lost. On a
 * wide screen the chip now fills the same right-hand slot as a thread's agent
 * (`ProjectSidePane`), swapping projects and closing on a second press, while
 * phones keep the sheet + full-page route they have always had.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createElement, forwardRef, useState } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const viewport = { width: 1440 }
const push = mock((_href: unknown) => {})

const PROJECTS = [
  { id: "proj-a", name: "Alpha", workspaceId: "ws-1" },
  { id: "proj-b", name: "Beta", workspaceId: "ws-1" },
]
const ATTACHMENTS = () => [
  { id: "att-a", projectId: "proj-a", attachMode: "readwrite" as const },
  { id: "att-b", projectId: "proj-b", attachMode: "readwrite" as const },
]

const guest = "Shogo"
const getPrimaryWorkspaceSession = mock(async () => ({ id: "session-1" }))
const getAgentProfile = mock(async () => ({ name: guest }))
const getWorkspaceSessionProjects = mock(async () => ATTACHMENTS())
const detachWorkspaceSessionProject = mock(async () => {})

/**
 * `react-native`'s mock forwards a Pressable's `onPress` to the host element as
 * the RN prop, which no DOM event fires. These three hosts publish what the
 * screen is tested through: `aria-label` (a press target), `aria-selected` (the
 * chip of the project in the pane) and `data-testid`.
 */
const pressable = forwardRef(function Pressable(props: any, ref: any) {
  const {
    accessibilityLabel,
    accessibilityRole,
    onPress,
    testID,
    disabled,
    className,
    children,
  } = props
  return createElement(
    "button",
    {
      ref,
      "aria-label": accessibilityLabel,
      "aria-selected": props["aria-selected"],
      "data-testid": testID,
      role: accessibilityRole ?? "button",
      type: "button",
      disabled,
      className,
      onClick: onPress,
    },
    children,
  )
})

const host = (tag: string) => (props: any) => {
  const {
    testID,
    accessibilityLabel,
    children,
    className,
    style,
    onPointerDown,
    onPointerEnter,
    onPointerLeave,
  } = props
  // The right-hand panes carry their width in `style`, which a DOM host would
  // otherwise drop — publish it so a test can read the pane's width. Only the
  // pointer handlers react-native-web actually forwards to the DOM are copied
  // across, so the harness can never stand in for a prop the browser drops.
  const width = Array.isArray(style) ? undefined : style?.width
  return createElement(
    tag,
    {
      "data-testid": testID,
      "aria-label": accessibilityLabel,
      className,
      "data-width": typeof width === "number" ? String(width) : undefined,
      onPointerDown,
      onPointerEnter,
      onPointerLeave,
    },
    children,
  )
}

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    useWindowDimensions: () => ({
      width: viewport.width,
      height: 900,
      scale: 1,
      fontScale: 1,
    }),
    Pressable: pressable,
    View: host("div"),
    Text: host("span"),
    ScrollView: host("div"),
  } as any),
)
mock.module("react-native-safe-area-context", () => ({
  SafeAreaView: host("div"),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
mock.module("expo-router", () => ({
  useRouter: () => ({ push, replace: mock(() => {}), back: mock(() => {}), setParams: mock(() => {}) }),
  useLocalSearchParams: () => ({}),
}))
mock.module("../../../contexts/auth", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}))
mock.module("../../../contexts/active-instance", () => ({
  useActiveInstance: () => ({ instance: null }),
}))
mock.module("../../../contexts/domain", () => {
  // Stable identities: the screen's load effect depends on `http` and the
  // collections, so a fresh object per render would loop it forever.
  const store = {
    all: PROJECTS,
    isLoading: false,
    loadAll: async () => PROJECTS,
    get: () => null,
    loadById: async () => null,
  }
  const http = { get: async () => ({ data: {} }) }
  return {
    useDomainHttp: () => http,
    useProjectCollection: () => store,
    useWorkspaceCollection: () => store,
    useMemberCollection: () => store,
  }
})
mock.module("../../../lib/switch-workspace", () => ({
  openInWorkspace: () => false,
  adoptChatWorkspace: () => false,
  shouldAdoptChatWorkspace: () => false,
}))
mock.module("../../../lib/team-workspace", () => ({ pickTeamWorkspace: () => null }))
mock.module("../../../hooks/useWorkspaceInView", () => ({
  useWorkspaceInView: () => ({ id: "ws-1", name: "Team", kind: "team" }),
}))
mock.module("../../../lib/workspace-in-view", () => ({
  workspaceInViewWhileLoading: (inView: unknown, last: unknown) => inView ?? last ?? null,
}))
mock.module("../../../lib/workspace-chats-cache", () => ({
  fetchWorkspaceChats: async () => [],
  workspaceChatsKey: () => "chats-key",
}))
mock.module("../../../lib/workspace-store", () => ({
  getActiveWorkspaceId: () => "ws-1",
  getCachedWorkspaceKind: () => "team",
  subscribeActiveWorkspaceId: () => () => {},
}))
mock.module("../../../hooks/useWorkspaceExperience", () => ({
  useWorkspaceExperience: () => ({ kind: "team", composer: undefined }),
}))
mock.module("../../../hooks/useChatPrefill", () => ({
  useChatPrefill: () => null,
  clearChatPrefill: () => {},
}))
mock.module("../../../lib/api", () => ({
  API_URL: "http://api.test",
  api: {
    getPrimaryWorkspaceSession,
    getAgentProfile,
    getWorkspaceSessionProjects,
    detachWorkspaceSessionProject,
    attachProject: mock(async () => ({})),
    createWorkspaceSession: mock(async () => ({ id: "session-new" })),
  },
}))
mock.module("../../../lib/chat-device-boot", () => ({
  chatHistoryOrigin: () => "local",
  loadWorkspaceChatBoot: async () => null,
  peekWorkspaceChatBoot: () => null,
  rememberWorkspaceChatBoot: () => {},
  workspaceChatBootKey: () => "boot-key",
  workspaceChatLoadingView: () => null,
}))
mock.module("../../../lib/chat-session-events", () => ({
  chatActivityEvents: { emit: () => {} },
  chatSessionEvents: { emit: () => {} },
}))
mock.module("../../../lib/chat-mention-meta", () => ({
  chatMentionMetaFor: async () => null,
}))
mock.module("../../../lib/root-destination", () => ({
  agentSessionSource: ({ initialSessionId, startNewSession, kind }: any) =>
    initialSessionId ? "url" : startNewSession && kind === "team" ? "new" : "primary",
}))
mock.module("../../../lib/landing-session", () => ({
  ensureLandingSession: async () => ({ id: "session-new" }),
  LANDING_SESSION_NAME: "Chat",
}))
mock.module("../../../lib/agent-proxy-base", () => ({
  projectAgentProxyBase: () => "http://agent.test",
}))

const pane = mock((props: any) =>
  createElement("div", {
    "data-testid": "project-side-pane",
    "data-project-id": props.projectId,
    "data-name": props.name,
    "data-tab": props.initialTab,
  }),
)
mock.module("../../team-chat/ProjectSidePane", () => ({ ProjectSidePane: pane }))
/**
 * The Working set is a chat-dock panel now (SHO-484), so this stands in for
 * `ChatDock`: one card per descriptor the screen hands `ChatPanel`, with the
 * real header fields (title, summary, header actions) and a toggle that mounts
 * the descriptor's body — `defaultExpanded: false` keeps it collapsed until
 * then, exactly like the real dock.
 */
const DockPanelStandIn = ({ descriptor }: { descriptor: any }) => {
  const [expanded, setExpanded] = useState(descriptor.defaultExpanded === true)
  return createElement(
    "div",
    { "data-testid": `dock-panel-${descriptor.id}` },
    createElement(
      "div",
      { "data-testid": `dock-header-${descriptor.id}` },
      createElement("span", null, descriptor.title),
      descriptor.summary
        ? createElement(
            "span",
            { "data-testid": `dock-summary-${descriptor.id}` },
            descriptor.summary,
          )
        : null,
      descriptor.headerActions ?? null,
      createElement(
        "button",
        {
          type: "button",
          "aria-label": `Toggle ${descriptor.title}`,
          onClick: () => setExpanded((open: boolean) => !open),
        },
        "toggle",
      ),
    ),
    expanded
      ? createElement(
          "div",
          { "data-testid": `dock-body-${descriptor.id}` },
          descriptor.render({ expanded: true }),
        )
      : null,
  )
}
mock.module("../../chat/ChatPanel", () => ({
  ChatPanel: (props: any) =>
    createElement(
      "div",
      { "data-testid": "chat-panel" },
      ...(props.dockPanels ?? []).map((descriptor: any) =>
        createElement(DockPanelStandIn, { key: descriptor.id, descriptor }),
      ),
    ),
}))
mock.module("../../chat/PlanStreamContext", () => ({
  PlanStreamProvider: host("div"),
}))
mock.module("../../chat/share-file-context", () => ({
  ShareFileProvider: host("div"),
}))
mock.module("../../chat/ShareFileViewer", () => ({ ShareFileView: () => null }))
mock.module("../../project/panels/PlansPanel", () => ({ PlansPanel: () => null }))
mock.module("../../chat/remote-project-paths", () => ({
  filePaneTarget: (path: string) => ({ path, projectId: null }),
}))
mock.module("../../chat/task/TaskThreadPaneHost", () => ({
  TaskThreadPaneHost: () => null,
}))
mock.module("../../phone/NativePhoneSheet", () => ({
  NativePhoneSheet: (props: any) =>
    props.visible
      ? createElement(
          "div",
          { "data-testid": "phone-sheet" },
          createElement("h1", null, props.title),
          props.children,
        )
      : null,
}))
mock.module("../../personal/PersonalAgentHeader", () => ({
  PersonalAgentHeader: () => null,
}))
mock.module("../../personal/PersonalAgentMobileHeader", () => ({
  PersonalAgentMobileHeader: () => null,
}))
mock.module("../../personal/BuddyLookSheet", () => ({ BuddyLookSheet: () => null }))
mock.module("../../personal/useWelcomeMessage", () => ({
  useWelcomeMessage: () => ({ showWelcome: false, dismissWelcome: () => {} }),
}))
mock.module("../../personal/ProfileActionMenu", () => ({
  buildDefaultProfileActions: () => [],
}))
mock.module("../../layout/MobileWorkspaceChromeContext", () => ({
  useMobileWorkspaceChrome: () => false,
}))
mock.module("../workspace-agent-session-bus", () => ({
  publishCurrentWorkspaceSession: () => {},
  publishWorkspaceSessionScopeChanged: () => {},
  subscribeWorkspaceSessionScopeChanged: () => () => {},
}))
mock.module("../WorkspaceFileViewer", () => ({ WorkspaceFileViewer: () => null }))
mock.module("../use-file-link-arrival", () => ({
  useFileLinkArrival: () => ({
    error: null,
    dismissError: () => {},
    dropLinkParams: () => {},
  }),
}))

const { cleanup, fireEvent, render, screen, waitFor, within } = await import(
  "@testing-library/react"
)
const { WorkspaceAgentChatScreen } = await import("../WorkspaceAgentChatScreen")
const { safeGetItem, safeRemoveItem, safeSetItem } = await import(
  "../../../lib/safe-storage"
)

beforeEach(() => {
  push.mockClear()
  getWorkspaceSessionProjects.mockClear()
  detachWorkspaceSessionProject.mockClear()
  viewport.width = 1440
})

/** Mounts the screen and waits for the dock panel the API's attachments add. */
const openScreen = async () => {
  render(createElement(WorkspaceAgentChatScreen, {}))
  await waitFor(() => {
    expect(screen.getByText("Working set")).toBeInTheDocument()
  })
}

/** The dock card the screen hands `ChatPanel`, and its collapsed header. */
const dockPanel = () => screen.getByTestId("dock-panel-working-set")
const summary = () =>
  screen.getByTestId("dock-summary-working-set").textContent
const expandPanel = () =>
  fireEvent.click(screen.getByLabelText("Toggle Working set"))

const chip = (name: string) => screen.getByLabelText(`${name} project`)
const paneShown = () => screen.queryByTestId("project-side-pane")

test("the working set is one dock panel, collapsed above the composer", async () => {
  await openScreen()

  expect(dockPanel()).toBeInTheDocument()
  // Collapsed header: the focused project and how many follow it.
  expect(summary()).toBe("Alpha +1")
  // The chips live in the panel's body, so they are not on screen yet — and
  // the old always-visible row above the transcript is gone.
  expect(screen.queryByLabelText("Alpha project")).toBeNull()
  expect(paneShown()).toBeNull()
})

test("expanding the panel lists every attached project as a chip", async () => {
  await openScreen()

  expandPanel()

  expect(screen.getByTestId("working-set-projects")).toBeInTheDocument()
  expect(chip("Alpha")).toBeInTheDocument()
  expect(chip("Beta")).toBeInTheDocument()
  expect(paneShown()).toBeNull()
})

test("a chip opens the project beside the chat, leaving the chat mounted", async () => {
  await openScreen()
  expandPanel()

  fireEvent.click(chip("Alpha"))

  const open = await waitFor(() => {
    const shown = paneShown()
    expect(shown).not.toBeNull()
    return shown!
  })
  expect(open.getAttribute("data-project-id")).toBe("proj-a")
  expect(open.getAttribute("data-name")).toBe("Alpha")
  expect(open.getAttribute("data-tab")).toBe("canvas")
  expect(chip("Alpha").getAttribute("aria-selected")).toBe("true")
  // The chat never navigated: the pane sits beside it, not instead of it.
  expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
  expect(push).not.toHaveBeenCalled()
})

test("a second chip swaps the pane, the same chip closes it", async () => {
  await openScreen()
  expandPanel()

  fireEvent.click(chip("Alpha"))
  await waitFor(() => expect(paneShown()).not.toBeNull())

  fireEvent.click(chip("Beta"))
  await waitFor(() =>
    expect(paneShown()?.getAttribute("data-project-id")).toBe("proj-b"),
  )
  expect(screen.getAllByTestId("project-side-pane")).toHaveLength(1)
  expect(chip("Beta").getAttribute("aria-selected")).toBe("true")
  expect(chip("Alpha").getAttribute("aria-selected")).toBe("false")

  fireEvent.click(chip("Beta"))
  await waitFor(() => expect(paneShown()).toBeNull())
})

test("the dock header's Manage button opens the scope sheet without expanding", async () => {
  await openScreen()

  // Reachable while the panel is collapsed.
  expect(screen.queryByLabelText("Alpha project")).toBeNull()
  fireEvent.click(screen.getByLabelText("Manage project scope"))
  await waitFor(() => expect(screen.getByText("Project scope")).toBeInTheDocument())
})

test("the scope sheet's Open puts the project in the pane and closes the sheet", async () => {
  await openScreen()

  fireEvent.click(screen.getByLabelText("Manage project scope"))
  await waitFor(() => expect(screen.getByText("Project scope")).toBeInTheDocument())

  fireEvent.click(screen.getByLabelText("Open Alpha"))

  await waitFor(() =>
    expect(paneShown()?.getAttribute("data-project-id")).toBe("proj-a"),
  )
  expect(screen.queryByText("Project scope")).toBeNull()
  expect(push).not.toHaveBeenCalled()
})

test("detaching the project shown in the pane closes it", async () => {
  await openScreen()
  expandPanel()

  fireEvent.click(chip("Alpha"))
  await waitFor(() => expect(paneShown()).not.toBeNull())

  fireEvent.click(screen.getByLabelText("Manage project scope"))
  await waitFor(() => expect(screen.getByText("Project scope")).toBeInTheDocument())

  detachWorkspaceSessionProject.mockImplementationOnce(async () => {})
  fireEvent.click(screen.getAllByText("Detach")[0].closest("button")!)

  await waitFor(() => expect(detachWorkspaceSessionProject).toHaveBeenCalled())
  await waitFor(() => expect(paneShown()).toBeNull())
})

test("on a phone the panel's chip opens the project page instead of a pane", async () => {
  viewport.width = 800
  await openScreen()
  expandPanel()

  fireEvent.click(chip("Alpha"))

  expect(push).toHaveBeenCalledWith({
    pathname: "/(app)/projects/[id]",
    params: {
      id: "proj-a",
      chatSessionId: "session-1",
      chatScope: "workspace",
    },
  })
  expect(paneShown()).toBeNull()
})

test("on a phone the scope sheet and its Open route still work", async () => {
  viewport.width = 800
  await openScreen()

  fireEvent.click(screen.getByLabelText("Manage project scope"))
  await waitFor(() => expect(screen.getByText("Project scope")).toBeInTheDocument())

  fireEvent.click(screen.getByLabelText("Open Alpha"))

  expect(push).toHaveBeenCalledWith({
    pathname: "/(app)/projects/[id]",
    params: {
      id: "proj-a",
      chatSessionId: "session-1",
      chatScope: "workspace",
    },
  })
  expect(paneShown()).toBeNull()
})

/** The wrapper the screen puts around the project pane — its width lives here. */
const paneHost = () => screen.getByTestId("workspace-project-pane")

const openProjectPaneFor = async (name = "Alpha") => {
  await openScreen()
  expandPanel()
  fireEvent.click(chip(name))
  await waitFor(() => expect(paneShown()).not.toBeNull())
}

test("the project pane offers a resize handle and takes its width from storage", async () => {
  safeSetItem("shogo.workspaceChat.projectPaneWidth", "560")
  await openProjectPaneFor()

  expect(paneHost().getAttribute("data-width")).toBe("560")
  expect(within(paneHost()).getByLabelText("Resize panel")).toBeInTheDocument()
})

test("with nothing saved the pane keeps 45% of the row", async () => {
  await openProjectPaneFor()

  // happy-dom reports no row layout, so the pane measures the window: 45% of 1440.
  expect(paneHost().getAttribute("data-width")).toBe("648")
})

test("dragging the handle widens the pane live and remembers it", async () => {
  await openProjectPaneFor()
  const handle = within(paneHost()).getByLabelText("Resize panel")

  fireEvent.pointerDown(handle, { clientX: 900 })
  fireEvent.pointerMove(document, { clientX: 700 })
  expect(paneHost().getAttribute("data-width")).toBe("848")

  fireEvent.pointerUp(document)
  expect(safeGetItem("shogo.workspaceChat.projectPaneWidth")).toBe("848")
})

test("a saved width never squeezes the chat below 480px", async () => {
  // 1440 - 480 leaves the pane at most 960, however wide it was dragged.
  safeSetItem("shogo.workspaceChat.projectPaneWidth", "1400")
  await openProjectPaneFor()

  expect(paneHost().getAttribute("data-width")).toBe("960")
})

test("double-clicking the handle restores the 45% default", async () => {
  safeSetItem("shogo.workspaceChat.projectPaneWidth", "560")
  await openProjectPaneFor()
  const handle = within(paneHost()).getByLabelText("Resize panel")

  // A click is a press released in place, and two of those in a row is the
  // double-click the handle has to recognise itself: react-native-web never
  // delivers `dblclick` to a View, and the drag overlay takes the pointerup
  // that would make the browser count a second `click`.
  fireEvent.pointerDown(handle, { clientX: 900 })
  fireEvent.pointerUp(document)
  fireEvent.pointerDown(handle, { clientX: 900 })

  expect(paneHost().getAttribute("data-width")).toBe("648")
  expect(safeGetItem("shogo.workspaceChat.projectPaneWidth")).toBeNull()
})

test("a drag released in place is not the first half of a double-click", async () => {
  await openProjectPaneFor()
  const handle = within(paneHost()).getByLabelText("Resize panel")

  fireEvent.pointerDown(handle, { clientX: 900 })
  fireEvent.pointerMove(document, { clientX: 800 })
  fireEvent.pointerUp(document)
  expect(paneHost().getAttribute("data-width")).toBe("748")

  // Pressing again straight after a drag starts a new drag, it does not reset.
  fireEvent.pointerDown(handle, { clientX: 900 })
  fireEvent.pointerUp(document)
  expect(paneHost().getAttribute("data-width")).toBe("748")
})

afterEach(() => {
  cleanup()
  safeRemoveItem("shogo.workspaceChat.projectPaneWidth")
  safeRemoveItem("shogo.workspaceChat.planPaneWidth")
  safeRemoveItem("shogo.workspaceChat.filePaneWidth")
})
