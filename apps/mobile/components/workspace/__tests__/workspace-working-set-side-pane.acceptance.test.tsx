// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-427 (QA): a Working set project has to land in the
 * *shared* right-hand slot, and phone chrome has to keep its old route.
 *
 * Two criteria the card states and a chip-only test cannot prove:
 *
 * 1. "an open plan or file pane is replaced (shared slot)" — a chip press must
 *    take the slot from a plan or file pane, not stack a second column beside
 *    it. So this file opens each of those panes through `ChatPanel`'s own
 *    handlers first, then presses a chip.
 * 2. "below 1024px / phone chrome" — a wide window that is rendering phone
 *    chrome has no side slot either, so the chip must keep opening the sheet
 *    and the sheet's Open must keep routing to the project page.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createElement, forwardRef, useState } from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const viewport = { width: 1440 }
const chrome = { mobile: false }
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
 * The Working set is a chat-dock panel now (SHO-484). This stands in for
 * `ChatDock` — one card per descriptor the screen hands `ChatPanel`, its real
 * header fields, and a toggle that mounts the body — while keeping the
 * file/plan buttons the real panel uses to fill the side slot.
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
  // The real panel opens these panes from file-link and plan buttons; the test
  // needs the very same handlers the screen passes down.
  ChatPanel: (props: any) =>
    createElement(
      "div",
      { "data-testid": "chat-panel" },
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "open file",
          onClick: () => props.onOpenFilePath?.("README.md"),
        },
        "file",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "open plan",
          onClick: () => props.onOpenPlan?.(),
        },
        "plan",
      ),
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
  useMobileWorkspaceChrome: () => chrome.mobile,
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

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
)
const { WorkspaceAgentChatScreen } = await import("../WorkspaceAgentChatScreen")

beforeEach(() => {
  push.mockClear()
  getWorkspaceSessionProjects.mockClear()
  detachWorkspaceSessionProject.mockClear()
  viewport.width = 1440
  chrome.mobile = false
})

/** Mounts the screen and waits for the dock panel the API's attachments add. */
const openScreen = async () => {
  render(createElement(WorkspaceAgentChatScreen, {}))
  await waitFor(() => {
    expect(screen.getByText("Working set")).toBeInTheDocument()
  })
}

const expandPanel = () =>
  fireEvent.click(screen.getByLabelText("Toggle Working set"))
const chip = (name: string) => screen.getByLabelText(`${name} project`)
const paneShown = () => screen.queryByTestId("project-side-pane")
const paneProject = () => paneShown()?.getAttribute("data-project-id")
const filePaneShown = () => screen.queryByTestId("workspace-file-pane")
const planPaneShown = () => screen.queryByTestId("workspace-plan-pane")

test("a chip takes the side slot from an open file pane instead of stacking beside it", async () => {
  await openScreen()
  expandPanel()

  fireEvent.click(screen.getByLabelText("open file"))
  await waitFor(() => expect(filePaneShown()).not.toBeNull())

  fireEvent.click(chip("Alpha"))

  await waitFor(() => expect(paneProject()).toBe("proj-a"))
  expect(filePaneShown()).toBeNull()
  expect(screen.getAllByTestId("project-side-pane")).toHaveLength(1)
  // The chat is beside the new pane, not replaced by it.
  expect(screen.getByTestId("chat-panel")).toBeInTheDocument()
  expect(push).not.toHaveBeenCalled()
})

test("a chip takes the side slot from an open plan pane too", async () => {
  await openScreen()
  expandPanel()

  fireEvent.click(screen.getByLabelText("open plan"))
  await waitFor(() => expect(planPaneShown()).not.toBeNull())

  fireEvent.click(chip("Beta"))

  await waitFor(() => expect(paneProject()).toBe("proj-b"))
  expect(planPaneShown()).toBeNull()
  expect(push).not.toHaveBeenCalled()
})

test("wide but on phone chrome there is no side slot: the chip routes to the project page", async () => {
  // 1440 px wide, yet phone chrome is mounted — `hasSidePane` is false, so the
  // working set must behave exactly like a phone.
  chrome.mobile = true
  await openScreen()
  expandPanel()

  fireEvent.click(chip("Alpha"))

  expect(paneShown()).toBeNull()
  expect(push).toHaveBeenCalledWith({
    pathname: "/(app)/projects/[id]",
    params: {
      id: "proj-a",
      chatSessionId: "session-1",
      chatScope: "workspace",
    },
  })
})

test("phone chrome with attachments adds no clearance above the transcript", async () => {
  // The old working-set row paid `insets.top + 112` itself *and* the
  // transcript paid `phoneTranscriptTopPadding` again (SHO-484). With the row
  // gone, only a welcome card reserves that clearance.
  chrome.mobile = true
  await openScreen()

  expect(screen.getByTestId("dock-panel-working-set")).toBeInTheDocument()
  expect(screen.queryByTestId("workspace-welcome-clearance")).toBeNull()
})

afterEach(() => cleanup())
