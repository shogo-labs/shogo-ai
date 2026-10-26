// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { resolve } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

const DEFAULT_SESSIONS = () => [
  {
    id: "chat-1",
    workspaceId: "w1",
    name: "Birthday party",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastActiveAt: "2026-10-01T10:00:00.000Z",
    isPinned: false,
    isArchived: false,
  },
  {
    id: "chat-2",
    workspaceId: "w1",
    name: "Trip ideas",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastActiveAt: "2026-09-01T10:00:00.000Z",
    isPinned: false,
    isArchived: false,
  },
];
// The panel re-reads on focus, so an override has to hold for every call.
const listWorkspaceSessions = mock(async () => DEFAULT_SESSIONS());
const createWorkspaceSession = mock(async () => ({
  id: "chat-new",
  workspaceId: "w1",
  attached: [],
}));
const updateChatSession = mock(async () => {});
const deleteChatSession = mock(async () => {});
// No turn is running on the server unless a test says so.
const listWorkspaceActiveChats = mock(async () => []);
const push = mock((_href: unknown) => {});

const Icon = ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
  createElement("span", { "aria-label": accessibilityLabel });

const Pressable = ({
  accessibilityLabel,
  accessibilityRole,
  children,
  onPress,
  testID,
  disabled,
  ...props
}: any) =>
  createElement(
    "button",
    {
      ...props,
      role: accessibilityRole ?? "button",
      "aria-label": accessibilityLabel,
      "data-rn-shim": testID,
      disabled,
      onClick: onPress,
    },
    children,
  );

const View = ({ accessibilityLabel, children, testID, ...props }: any) =>
  createElement(
    "div",
    {
      ...props,
      "aria-label": accessibilityLabel,
      "data-rn-shim": testID,
      "data-testid": testID,
    },
    children,
  );

mock.module("react-native", () => createReactNativeMock({ Pressable, View }));
mock.module("expo-router", () => ({
  useRouter: () => ({ push, replace: mock(() => {}) }),
  usePathname: () => "/(app)/agent",
  useLocalSearchParams: () => ({ chatSessionId: "chat-1" }),
  useFocusEffect: (callback: () => void) => {
    // Mirrors expo-router: run on focus (mount, in a test) and clean up after.
    const { useEffect } = require("react") as typeof import("react");
    useEffect(callback, [callback]);
  },
}));
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
mock.module("lucide-react-native", () => ({
  Archive: Icon,
  ArchiveRestore: Icon,
  Check: Icon,
  ChevronDown: Icon,
  ChevronRight: Icon,
  Loader2: Icon,
  MoreHorizontal: Icon,
  Pencil: Icon,
  Pin: Icon,
  PinOff: Icon,
  Plus: Icon,
  Trash2: Icon,
  X: Icon,
}));
mock.module(resolve(import.meta.dir, "../../../phone/NativePhoneSheet"), () => ({
  NativePhoneSheet: () => null,
}));
mock.module(resolve(import.meta.dir, "../../SidebarContextMenu"), () => ({
  SidebarContextMenu: ({ items }: { items: any[] }) =>
    createElement(
      "div",
      null,
      items
        .filter((item) => !item.separator)
        .map((item, index) =>
          createElement(
            "button",
            {
              key: index,
              "aria-label": `menu ${item.label}`,
              onClick: item.onSelect,
            },
            item.label,
          ),
        ),
    ),
}));
mock.module(
  resolve(import.meta.dir, "../../../../lib/native-phone-layout"),
  () => ({
    isNativePlatform: () => false,
    isPhoneLayout: () => false,
    useIsNativePhoneLayout: () => false,
    usePhoneLayout: () => false,
  }),
);
mock.module(resolve(import.meta.dir, "../../../../contexts/domain"), () => ({
  useDomainHttp: () => ({}),
  useDomainActions: () => ({ updateChatSession, deleteChatSession }),
  useChatSessionCollection: () => ({
    get: () => undefined,
    loadById: async () => {},
  }),
}));
mock.module(resolve(import.meta.dir, "../../../../lib/api"), () => ({
  api: {
    listWorkspaceSessions,
    createWorkspaceSession,
    listWorkspaceActiveChats,
  },
}));
mock.module(resolve(import.meta.dir, "../../../../hooks/useActiveWorkspace"), () => ({
  useActiveWorkspace: () => ({ id: "w1", kind: "personal" }),
}));

const { WorkspaceChatsPanel } = await import("../WorkspaceChatsPanel");
const { chatActivityEvents, chatSessionEvents } = await import(
  "../../../../lib/chat-session-events"
);

beforeEach(() => {
  cleanup();
  push.mockClear();
  updateChatSession.mockClear();
  deleteChatSession.mockClear();
  listWorkspaceSessions.mockClear();
  listWorkspaceSessions.mockImplementation(async () => DEFAULT_SESSIONS());
  listWorkspaceActiveChats.mockClear();
  listWorkspaceActiveChats.mockImplementation(async () => []);
});

describe("WorkspaceChatsPanel", () => {
  test("renders this person's chats from the one list call, with no section header", async () => {
    render(<WorkspaceChatsPanel />);

    await screen.findByLabelText("Chat: Birthday party");
    expect(listWorkspaceSessions).toHaveBeenCalledWith(expect.anything(), "w1");
    expect(screen.getByLabelText("Chat: Trip ideas")).toBeTruthy();
    // Flat: no "Workspace agent" title row and no project rows.
    expect(screen.queryByText("Workspace agent")).toBeNull();
    expect(screen.queryByLabelText(/^Project: /)).toBeNull();
    expect(screen.getByTestId("workspace-chats-panel")).toBeTruthy();
  });

  test("a workspace-scoped activity emit paints the spinner on that row only", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");

    // chat-2 is the one running — not the chat on screen.
    act(() => {
      chatActivityEvents.emit({
        workspaceId: "w1",
        streamingSessionIds: ["chat-2"],
        completedSessionIds: [],
      });
    });

    expect(screen.getAllByLabelText("Chat running")).toHaveLength(1);

    // A project-scoped event of the same shape must not touch a workspace row.
    act(() => {
      chatActivityEvents.emit({
        projectId: "p1",
        streamingSessionIds: ["chat-1"],
        completedSessionIds: [],
      });
    });
    expect(screen.getAllByLabelText("Chat running")).toHaveLength(1);

    // The turn ending is a real transition: spinner off, unread dot on.
    act(() => {
      chatActivityEvents.emit({
        workspaceId: "w1",
        streamingSessionIds: [],
        completedSessionIds: ["chat-2"],
        finishedSessionIds: ["chat-2"],
      });
    });
    expect(screen.queryByLabelText("Chat running")).toBeNull();
    expect(screen.getByLabelText("Chat has new activity")).toBeTruthy();
  });

  test("a blank emit (chat switch / unmount) never stops a running row", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");

    act(() => {
      chatActivityEvents.emit({
        workspaceId: "w1",
        streamingSessionIds: ["chat-2"],
        completedSessionIds: [],
      });
    });
    expect(screen.getAllByLabelText("Chat running")).toHaveLength(1);

    // WorkspaceAgentChatScreen emits exactly this when you switch chats while a
    // turn is still running somewhere else: it is not an "everything finished".
    act(() => {
      chatActivityEvents.emit({
        workspaceId: "w1",
        streamingSessionIds: [],
        completedSessionIds: [],
      });
    });
    expect(screen.getAllByLabelText("Chat running")).toHaveLength(1);
  });

  test("a turn the server reports running spins without any local event", async () => {
    listWorkspaceActiveChats.mockImplementation(async () => [
      {
        chatSessionId: "chat-2",
        turnId: "turn-1",
        sessionName: "Trip ideas",
        isPrimary: false,
        projectId: null,
        projectName: null,
        projectHidden: false,
        startedAt: "2099-01-01T00:00:00.000Z",
      } as any,
    ]);

    render(<WorkspaceChatsPanel />);

    await waitFor(() =>
      expect(screen.getAllByLabelText("Chat running")).toHaveLength(1),
    );
    expect(listWorkspaceActiveChats).toHaveBeenCalled();
  });

  test("a pinned row shows a pin, and an unpinned one does not", async () => {
    listWorkspaceSessions.mockImplementation(async () => [
      {
        id: "chat-1",
        workspaceId: "w1",
        name: "Birthday party",
        createdAt: "2026-10-01T10:00:00.000Z",
        lastActiveAt: "2026-10-01T10:00:00.000Z",
        isPinned: true,
        isArchived: false,
      },
      {
        id: "chat-2",
        workspaceId: "w1",
        name: "Trip ideas",
        createdAt: "2026-09-01T10:00:00.000Z",
        lastActiveAt: "2026-09-01T10:00:00.000Z",
        isPinned: false,
        isArchived: false,
      },
    ]);

    render(<WorkspaceChatsPanel />);

    await screen.findByLabelText("Chat: Birthday party");
    expect(screen.getAllByLabelText("Pinned")).toHaveLength(1);
  });

  test("pin goes through the one update path", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");

    fireEvent.click(screen.getByLabelText("Manage Birthday party"));
    fireEvent.click(screen.getByLabelText("menu Pin"));
    await waitFor(() =>
      expect(updateChatSession).toHaveBeenCalledWith("chat-1", {
        isPinned: true,
      }),
    );
  });

  test("archive goes through the same path", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Trip ideas");

    fireEvent.click(screen.getByLabelText("Manage Trip ideas"));
    fireEvent.click(screen.getByLabelText("menu Archive"));
    await waitFor(() =>
      expect(updateChatSession).toHaveBeenCalledWith("chat-2", {
        isArchived: true,
      }),
    );
  });

  test("deleting opens the in-app dialog and never window.confirm", async () => {
    const confirm = mock(() => true);
    (globalThis.window as any).confirm = confirm;

    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");

    fireEvent.click(screen.getByLabelText("Manage Birthday party"));
    fireEvent.click(screen.getByLabelText("menu Delete"));

    expect(screen.getByText("Delete chat")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Delete"));

    await waitFor(() => expect(deleteChatSession).toHaveBeenCalledWith("chat-1"));
    expect(confirm).not.toHaveBeenCalled();
  });

  test("New chat creates a chat and opens it", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() =>
      expect(createWorkspaceSession).toHaveBeenCalledWith(
        expect.anything(),
        "w1",
        {},
      ),
    );
    expect(push).toHaveBeenCalledWith({
      pathname: "/(app)/agent",
      params: { chatSessionId: "chat-new" },
    });
  });

  test("a workspace refresh event re-reads the list (one load path)", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");
    const before = listWorkspaceSessions.mock.calls.length;

    act(() => {
      chatSessionEvents.emit({ workspaceId: "w1", refresh: true });
    });

    await waitFor(() =>
      expect(listWorkspaceSessions.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
