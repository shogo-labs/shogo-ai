// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace-agent session opened from a channel thread is headed by the
 * `#shogo-dev › Thread` trail and nothing else (SHO-438).
 *
 * The screen used to paint the companion identity block first — big avatar,
 * name, tagline, dress-up/rename menu — and the trail underneath it, so the
 * personal agent sat at the top of a team chat thread. The companion block is
 * still the header of `/agent` opened on its own.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createElement, forwardRef } from "react";
import { createReactNativeMock } from "../../../test/react-native-mock";

let chrome = false;
const insetsTop = 47;
const push = mock((_href: unknown) => {});

const PROJECTS: Array<Record<string, unknown>> = [];
const getPrimaryWorkspaceSession = mock(async () => ({ id: "session-1" }));
const getAgentProfile = mock(async () => ({
  name: "Shogo",
  tagline: "Your AI agent",
}));
const getWorkspaceSessionProjects = mock(async () => []);

const pressable = forwardRef(function Pressable(props: any, ref: any) {
  const { accessibilityLabel, accessibilityRole, onPress, testID, disabled, className, children } =
    props;
  return createElement(
    "button",
    {
      ref,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      role: accessibilityRole ?? "button",
      type: "button",
      disabled,
      className,
      onClick: onPress,
    },
    children,
  );
});

/** Keeps `style` on the DOM so the phone clearance below can be measured. */
const host = (tag: string) => (props: any) => {
  const { testID, accessibilityLabel, children, className, style } = props;
  return createElement(
    tag,
    {
      "data-testid": testID,
      "aria-label": accessibilityLabel,
      className,
      style,
    },
    children,
  );
};

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web" },
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
    Pressable: pressable,
    View: host("div"),
    Text: host("span"),
    ScrollView: host("div"),
  } as any),
);
mock.module("react-native-safe-area-context", () => ({
  SafeAreaView: host("div"),
  useSafeAreaInsets: () => ({ top: insetsTop, bottom: 0, left: 0, right: 0 }),
}));
// The real `PersonalAgentHeader` brings this in, and its index resolves
// `react-native` through the package's own node_modules, which the mock above
// cannot reach. Only `cn` is needed here.
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
mock.module("expo-router", () => ({
  useRouter: () => ({ push, replace: mock(() => {}), back: mock(() => {}), setParams: mock(() => {}) }),
  useLocalSearchParams: () => ({}),
}));
mock.module("../../../contexts/auth", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));
mock.module("../../../contexts/active-instance", () => ({
  useActiveInstance: () => ({ instance: null }),
}));
mock.module("../../../contexts/domain", () => {
  const store = {
    all: PROJECTS,
    isLoading: false,
    loadAll: async () => PROJECTS,
    get: () => null,
    loadById: async () => null,
  };
  const http = { get: async () => ({ data: {} }) };
  return {
    useDomainHttp: () => http,
    useProjectCollection: () => store,
    useWorkspaceCollection: () => store,
    useMemberCollection: () => store,
  };
});
mock.module("../../../lib/switch-workspace", () => ({
  openInWorkspace: () => false,
  adoptChatWorkspace: () => false,
  shouldAdoptChatWorkspace: () => false,
}));
mock.module("../../../lib/team-workspace", () => ({ pickTeamWorkspace: () => null }));
mock.module("../../../hooks/useWorkspaceInView", () => ({
  useWorkspaceInView: () => ({ id: "ws-1", name: "Team", kind: "team" }),
}));
mock.module("../../../lib/workspace-in-view", () => ({
  workspaceInViewWhileLoading: (inView: unknown, last: unknown) => inView ?? last ?? null,
}));
mock.module("../../../lib/workspace-chats-cache", () => ({
  fetchWorkspaceChats: async () => [],
  workspaceChatsKey: () => "chats-key",
}));
mock.module("../../../lib/workspace-store", () => ({
  getActiveWorkspaceId: () => "ws-1",
  getCachedWorkspaceKind: () => "team",
  subscribeActiveWorkspaceId: () => () => {},
}));
mock.module("../../../hooks/useWorkspaceExperience", () => ({
  // A personal workspace: this is where the companion identity block shows.
  useWorkspaceExperience: () => ({ kind: "personal", composer: undefined }),
}));
mock.module("../../../hooks/useChatPrefill", () => ({
  useChatPrefill: () => null,
  clearChatPrefill: () => {},
}));
mock.module("../../../lib/api", () => ({
  API_URL: "http://api.test",
  api: {
    getPrimaryWorkspaceSession,
    getAgentProfile,
    getWorkspaceSessionProjects,
    detachWorkspaceSessionProject: mock(async () => {}),
    attachProject: mock(async () => ({})),
    createWorkspaceSession: mock(async () => ({ id: "session-new" })),
  },
}));
mock.module("../../../lib/chat-device-boot", () => ({
  chatHistoryOrigin: () => "local",
  loadWorkspaceChatBoot: async () => null,
  peekWorkspaceChatBoot: () => null,
  rememberWorkspaceChatBoot: () => {},
  workspaceChatBootKey: () => "boot-key",
  workspaceChatLoadingView: () => null,
}));
mock.module("../../../lib/chat-session-events", () => ({
  chatActivityEvents: { emit: () => {} },
  chatSessionEvents: { emit: () => {} },
}));
mock.module("../../../lib/chat-mention-meta", () => ({
  chatMentionMetaFor: async () => null,
}));
mock.module("../../../lib/root-destination", () => ({
  agentSessionSource: ({ initialSessionId, startNewSession, kind }: any) =>
    initialSessionId ? "url" : startNewSession && kind === "team" ? "new" : "primary",
}));
mock.module("../../../lib/landing-session", () => ({
  ensureLandingSession: async () => ({ id: "session-new" }),
  LANDING_SESSION_NAME: "Chat",
}));
mock.module("../../../lib/agent-proxy-base", () => ({
  projectAgentProxyBase: () => "http://agent.test",
}));
mock.module("../../team-chat/ProjectSidePane", () => ({
  ProjectSidePane: () => createElement("div", { "data-testid": "project-side-pane" }),
}));
mock.module("../../chat/ChatPanel", () => ({
  ChatPanel: () => createElement("div", { "data-testid": "chat-panel" }),
}));
mock.module("../../chat/PlanStreamContext", () => ({
  PlanStreamProvider: host("div"),
}));
mock.module("../../chat/share-file-context", () => ({
  ShareFileProvider: host("div"),
}));
mock.module("../../chat/ShareFileViewer", () => ({ ShareFileView: () => null }));
mock.module("../../project/panels/PlansPanel", () => ({ PlansPanel: () => null }));
mock.module("../../chat/remote-project-paths", () => ({
  filePaneTarget: (path: string) => ({ path, projectId: null }),
}));
mock.module("../../chat/task/TaskThreadPaneHost", () => ({
  TaskThreadPaneHost: () => null,
}));
mock.module("../../phone/NativePhoneSheet", () => ({
  NativePhoneSheet: () => null,
}));
mock.module("../../chat/ChatColumn", () => ({
  ChatColumn: host("div"),
  ChatColumnProvider: host("div"),
  useIsInsideChatColumn: () => false,
}));
// The real headers render these; keep only the parts this test needs so the
// avatar's canvas and the profile popover never load.
mock.module("../../personal/ProfileActionMenu", () => ({
  ProfileActionMenu: ({ trigger }: any) => trigger({}),
  buildDefaultProfileActions: () => [],
}));
mock.module("../../personal/WorkspaceAgentAvatar", () => ({
  WorkspaceAgentAvatar: () => createElement("span", { "data-testid": "companion-avatar" }),
}));
mock.module("../../personal/BuddyLookSheet", () => ({ BuddyLookSheet: () => null }));
mock.module("../../personal/useWelcomeMessage", () => ({
  useWelcomeMessage: () => ({ showWelcome: false, dismissWelcome: () => {} }),
}));
mock.module("../../layout/MobileWorkspaceChromeContext", () => ({
  useMobileWorkspaceChrome: () => chrome,
}));
mock.module("../workspace-agent-session-bus", () => ({
  publishCurrentWorkspaceSession: () => {},
  publishWorkspaceSessionScopeChanged: () => {},
  subscribeWorkspaceSessionScopeChanged: () => () => {},
}));
mock.module("../WorkspaceFileViewer", () => ({ WorkspaceFileViewer: () => null }));
mock.module("../use-file-link-arrival", () => ({
  useFileLinkArrival: () => ({
    error: null,
    dismissError: () => {},
    dropLinkParams: () => {},
  }),
}));

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { WorkspaceAgentChatScreen } = await import("../WorkspaceAgentChatScreen");

/** `SessionBreadcrumb`'s stand-in: the trail the route passes as `header`. */
const trail = () =>
  createElement("div", { "data-testid": "thread-trail" }, "#shogo-dev › Thread › Shogo · session");

/**
 * The screen paints nothing until the workspace, its session and the agent's
 * profile have answered, so every test waits for the chat itself first.
 */
const openScreen = async (header?: React.ReactNode) => {
  render(createElement(WorkspaceAgentChatScreen, header ? { header } : {}));
  await waitFor(() => expect(screen.queryByTestId("chat-panel")).not.toBeNull());
};

const profileButton = () => screen.queryByLabelText("Shogo profile and settings");
const trailShown = () => screen.queryByTestId("thread-trail");

beforeEach(() => {
  chrome = false;
  push.mockClear();
});

afterEach(() => cleanup());

test("opened from a channel thread the trail is the whole header — wide", async () => {
  await openScreen(trail());

  expect(trailShown()).toBeInTheDocument();
  expect(profileButton()).toBeNull();
  expect(screen.queryByTestId("companion-avatar")).toBeNull();
});

test("opened from a channel thread the trail is the whole header — phone", async () => {
  chrome = true;
  await openScreen(trail());

  expect(trailShown()).toBeInTheDocument();
  expect(profileButton()).toBeNull();
  expect(screen.queryByTestId("companion-avatar")).toBeNull();
});

test("on a phone the trail clears the shell's floating menu and bell", async () => {
  chrome = true;
  await openScreen(trail());

  // The shell's buttons are 44 pt tall, 10 pt below the inset; the trail sits
  // under that row rather than under the companion cluster's old 112 pt band.
  const wrapper = trailShown()!.parentElement as HTMLElement;
  expect(wrapper.style.paddingTop).toBe(`${insetsTop + 54}px`);
});

test("opened on its own the companion header is unchanged — wide", async () => {
  await openScreen();

  expect(profileButton()).toBeInTheDocument();
  expect(trailShown()).toBeNull();
});

test("opened on its own the companion header is unchanged — phone", async () => {
  chrome = true;
  await openScreen();

  expect(profileButton()).toBeInTheDocument();
  expect(screen.getByTestId("companion-avatar")).toBeInTheDocument();
  expect(trailShown()).toBeNull();
});
