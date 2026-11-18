// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-438 acceptance — the screen's header, proven with the real trail.
 *
 * `workspace-session-header.rtl.test.tsx` passes a stand-in `<div>` as the
 * `header`, which proves the companion block stands down but says nothing
 * about what a person actually sees. These tests drive the same screen with
 * the real `SessionBreadcrumb` the route builds from the query params:
 *
 *  * a channel origin (`fromKind=public`) is headed by the conversation, the
 *    thread and the session, and the companion name / tagline / dress-up
 *    button are gone;
 *  * a DM origin (`fromKind=dm`) is headed by the same trail with no thread
 *    crumb, because a DM has no thread to step into;
 *  * every crumb but the current one still navigates back up;
 *  * on a phone the trail sits under the shell's floating menu/bell row —
 *    not under the companion cluster's old 112 pt band;
 *  * `/agent` opened on its own keeps the companion header, its tagline and
 *    the 112 pt clearance under the floating avatar.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createElement, forwardRef } from "react";
import { createReactNativeMock } from "../../../test/react-native-mock";

let chrome = false;
let welcome = false;
const insetsTop = 47;
const navigate = mock((_href: unknown) => {});
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

/** Keeps `style` on the DOM so padding and the 112 pt spacer can be measured. */
const host = (tag: string) => (props: any) => {
  const { testID, accessibilityLabel, accessibilityRole, children, className, style } = props;
  return createElement(
    tag,
    {
      "data-testid": testID,
      "aria-label": accessibilityLabel,
      role: accessibilityRole,
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
  useRouter: () => ({
    navigate,
    push,
    replace: mock(() => {}),
    back: mock(() => {}),
    setParams: mock(() => {}),
  }),
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
  useWelcomeMessage: () => ({ showWelcome: welcome, dismissWelcome: () => {} }),
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
const { SessionBreadcrumb } = await import("../../team-chat/SessionBreadcrumb");

/** The params `sessionRoute` builds for a workspace-agent session (SHO-412). */
const CHANNEL_ORIGIN = {
  chatSessionId: "chat-7",
  fromConversation: "conv-1",
  fromKind: "public",
  fromLabel: "shogo-dev",
  fromThread: "root-1",
  fromAgent: "Shogo",
};
const DM_ORIGIN = {
  chatSessionId: "chat-8",
  fromConversation: "dm-1",
  fromKind: "dm",
  fromLabel: "Russell",
  fromAgent: "Shogo",
};

/** The screen paints nothing until the workspace, session and profile answer. */
const openScreen = async (params?: Record<string, string>) => {
  render(
    createElement(
      WorkspaceAgentChatScreen,
      params ? { header: createElement(SessionBreadcrumb, { params }) } : {},
    ),
  );
  await waitFor(() => expect(screen.queryByTestId("chat-panel")).not.toBeNull());
};

const trailRoot = () => document.querySelector('[role="header"]') as HTMLElement | null;
const profileButton = () => screen.queryByLabelText("Shogo profile and settings");
/** Every element the screen sized to `height`, so the phone spacer is visible. */
const heights = () =>
  Array.from(document.querySelectorAll<HTMLElement>("div"))
    .map((el) => el.style.height)
    .filter(Boolean);

beforeEach(() => {
  chrome = false;
  welcome = false;
  navigate.mockClear();
  push.mockClear();
});

afterEach(() => cleanup());

test("a channel thread heads the session with the trail alone — wide", async () => {
  await openScreen(CHANNEL_ORIGIN);

  expect(trailRoot()).not.toBeNull();
  expect(screen.getByText("shogo-dev")).toBeInTheDocument();
  expect(screen.getByText("Thread")).toBeInTheDocument();
  expect(screen.getByText("Shogo · session")).toBeInTheDocument();

  // The companion block — avatar, name, tagline, dress-up/menu button — is gone.
  expect(profileButton()).toBeNull();
  expect(screen.queryByTestId("companion-avatar")).toBeNull();
  expect(screen.queryByText("Your AI agent")).toBeNull();

  // …and nothing sits above the trail: it is the first thing in the column.
  const wrapper = trailRoot()!.parentElement as HTMLElement;
  expect(wrapper.parentElement!.firstElementChild).toBe(wrapper);
});

test("a DM reply heads the session with the same trail, and no thread crumb", async () => {
  await openScreen(DM_ORIGIN);

  expect(screen.getByText("Russell")).toBeInTheDocument();
  expect(screen.getByText("Shogo · session")).toBeInTheDocument();
  // A DM has no thread to step into, so there is no middle crumb.
  expect(screen.queryByText("Thread")).toBeNull();
  expect(screen.queryByLabelText("Back to Thread")).toBeNull();

  expect(profileButton()).toBeNull();
  expect(screen.queryByTestId("companion-avatar")).toBeNull();
});

test("each crumb steps back up to the channel and to the thread", async () => {
  await openScreen(CHANNEL_ORIGIN);

  const channel = screen.getByLabelText("Back to shogo-dev");
  channel.click();
  expect(navigate).toHaveBeenLastCalledWith({
    pathname: "/(app)/c/[conversationId]",
    params: { conversationId: "conv-1" },
  });

  const thread = screen.getByLabelText("Back to Thread");
  thread.click();
  expect(navigate).toHaveBeenLastCalledWith({
    pathname: "/(app)/c/[conversationId]",
    params: { conversationId: "conv-1", thread: "root-1" },
  });

  // The session you are in is the end of the trail, not a link.
  expect(screen.queryByLabelText("Back to Shogo · session")).toBeNull();
});

test("on a phone the trail clears the shell's menu and bell, with no 112 pt band", async () => {
  chrome = true;
  await openScreen(CHANNEL_ORIGIN);

  // The shell floats its menu (left) and bell (right) 44 pt tall at
  // `insets.top + 10`, so the row ends at `insets.top + 54`.
  const padding = (trailRoot()!.parentElement as HTMLElement).style.paddingTop;
  expect(padding).toBe(`${insetsTop + 54}px`);
  // Not the companion cluster's old clearance, and no empty band above the trail.
  expect(Number.parseFloat(padding) - insetsTop).toBeLessThan(112);
  expect(heights()).not.toContain(`${insetsTop + 112}px`);
  expect(profileButton()).toBeNull();
});

test("opened on its own the companion header is unchanged — wide", async () => {
  await openScreen();

  expect(profileButton()).toBeInTheDocument();
  expect(screen.getByText("Your AI agent")).toBeInTheDocument();
  expect(screen.queryByTestId("companion-avatar")).toBeInTheDocument();
  expect(trailRoot()).toBeNull();
});

test("opened on its own the phone header and its clearance are unchanged", async () => {
  chrome = true;
  welcome = true;
  await openScreen();

  expect(profileButton()).toBeInTheDocument();
  expect(screen.getByTestId("companion-avatar")).toBeInTheDocument();
  expect(trailRoot()).toBeNull();
  // The welcome card below the floating cluster still clears it.
  expect(heights()).toContain(`${insetsTop + 112}px`);
});
