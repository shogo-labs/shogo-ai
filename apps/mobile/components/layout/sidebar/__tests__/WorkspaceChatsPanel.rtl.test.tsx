// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { resolve } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

const listWorkspaceSessions = mock(async () => [
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
]);
const createWorkspaceSession = mock(async () => ({
  id: "chat-new",
  workspaceId: "w1",
  attached: [],
}));
const updateChatSession = mock(async () => {});
const deleteChatSession = mock(async () => {});
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
  api: { listWorkspaceSessions, createWorkspaceSession },
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

    act(() => {
      chatActivityEvents.emit({
        workspaceId: "w1",
        streamingSessionIds: ["chat-1"],
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

    act(() => {
      chatActivityEvents.emit({
        workspaceId: "w1",
        streamingSessionIds: [],
        completedSessionIds: ["chat-1"],
      });
    });
    expect(screen.queryByLabelText("Chat running")).toBeNull();
    expect(screen.getByLabelText("Chat has new activity")).toBeTruthy();
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
