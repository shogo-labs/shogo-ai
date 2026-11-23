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

// SHO-391: the list is cached per user + server + workspace, and the rows live
// in AsyncStorage on the device.
const deviceStore = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => deviceStore.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      deviceStore.set(k, v);
    },
    removeItem: async (k: string) => {
      deviceStore.delete(k);
    },
    getAllKeys: async () => [...deviceStore.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => deviceStore.delete(k));
    },
  },
}));
mock.module(resolve(import.meta.dir, "../../../../contexts/auth"), () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));
mock.module(resolve(import.meta.dir, "../../../../contexts/active-instance"), () => ({
  useActiveInstance: () => ({ instance: null }),
}));

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
const { SidebarScrollProvider, createSidebarScrollSignal } = await import(
  "../SidebarScrollContext"
);
const { chatActivityEvents, chatSessionEvents } = await import(
  "../../../../lib/chat-session-events"
);
// The 5 s activity cache is one per window (SHO-277); a case here must not see
// the answer an earlier case cached.
const { workspaceActivity } = await import("../../../../lib/workspace-activity");
const workspaceChatsCache = await import("../../../../lib/workspace-chats-cache");

beforeEach(async () => {
  cleanup();
  workspaceActivity.reset();
  await workspaceChatsCache.clearWorkspaceChatsCache();
  deviceStore.clear();
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

// ─── SHO-391: a remount paints from the device ───────────────────────────────
//
// The sidebar renders one tab panel at a time, so every Home click mounted a
// fresh panel: `sessions = []` + `loading = true`, then a full refetch. The
// list it already had is now on the device.

describe("WorkspaceChatsPanel device cache", () => {
  test("a remount paints the last list with no loading state, before the list answers", async () => {
    const first = render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");
    first.unmount();

    // This mount will never get an answer: everything on screen is cached.
    listWorkspaceSessions.mockImplementation(
      () => new Promise(() => {}) as Promise<any[]>,
    );
    await act(async () => {
      render(<WorkspaceChatsPanel />);
    });

    expect(screen.getByLabelText("Chat: Birthday party")).toBeTruthy();
    expect(screen.getByLabelText("Chat: Trip ideas")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  test("a failing list keeps the rows that were already shown", async () => {
    render(<WorkspaceChatsPanel />);
    await screen.findByLabelText("Chat: Birthday party");

    listWorkspaceSessions.mockImplementation(async () => {
      throw new Error("offline");
    });
    await act(async () => {
      chatSessionEvents.emit({ workspaceId: "w1", refresh: true });
    });

    expect(screen.getByLabelText("Chat: Birthday party")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});

// ─── SHO-530: Home grows as the sidebar scrolls ─────────────────────────────
//
// Russell: "workspace chats shouldn't have a show 5 more, it should be
// infinite scroll." The panel now pages on the sidebar's scroll signal, so it
// hands no `onSeeAll` down and draws no paging row at all.

/** 75 chats, newest first — the order `sortSideChats` renders them in. */
const manyChats = (count = 75) =>
  Array.from({ length: count }, (_, index) => {
    const stamp = new Date(Date.now() - index * 3600_000).toISOString();
    return {
      id: `chat-${index + 1}`,
      workspaceId: "w1",
      name: `Chat ${index + 1}`,
      createdAt: stamp,
      lastActiveAt: stamp,
      isPinned: false,
      isArchived: false,
    };
  });

const renderedChatLabels = () =>
  screen.getAllByLabelText(/^Chat: /).map((row) => row.getAttribute("aria-label"));

const renderInPanelScroll = (signal: any) =>
  render(
    <SidebarScrollProvider signal={signal}>
      <WorkspaceChatsPanel />
    </SidebarScrollProvider>,
  );

describe("WorkspaceChatsPanel infinite paging", () => {
  test("AC1: 75 chats draw 30 rows and no Show more / Show less / See all row", async () => {
    listWorkspaceSessions.mockImplementation(async () => manyChats());
    renderInPanelScroll(createSidebarScrollSignal());

    await screen.findByLabelText("Chat: Chat 1");
    expect(renderedChatLabels()).toHaveLength(30);
    expect(screen.queryByLabelText(/Show more chats/)).toBeNull();
    expect(screen.queryByLabelText(/Show fewer chats/)).toBeNull();
    expect(screen.queryByLabelText(/See all chats/)).toBeNull();
    expect(screen.queryByText(/^See all/)).toBeNull();
    expect(screen.queryByText("Show more")).toBeNull();
  });

  test("AC2: a sidebar scroll-end draws the next 30, then the last 15", async () => {
    const signal = createSidebarScrollSignal();
    listWorkspaceSessions.mockImplementation(async () => manyChats());
    renderInPanelScroll(signal);

    await screen.findByLabelText("Chat: Chat 1");

    act(() => signal.notify());
    expect(renderedChatLabels()).toHaveLength(60);

    act(() => signal.notify());
    const labels = renderedChatLabels();
    expect(labels).toHaveLength(75);
    expect(labels[0]).toBe("Chat: Chat 1");
    expect(labels[74]).toBe("Chat: Chat 75");
    expect(new Set(labels).size).toBe(75);
  });

  test("AC7: with no sidebar scroll view it draws every chat rather than hiding them", async () => {
    listWorkspaceSessions.mockImplementation(async () => manyChats());
    render(<WorkspaceChatsPanel />);

    await screen.findByLabelText("Chat: Chat 75");
    expect(renderedChatLabels()).toHaveLength(75);
    expect(screen.queryByLabelText(/See all chats/)).toBeNull();
  });
});
