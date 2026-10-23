// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { resolve } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3600_000).toISOString();

const Icon = ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
  createElement("span", { "aria-label": accessibilityLabel });

const Pressable = ({
  accessibilityLabel,
  accessibilityRole,
  children,
  onPress,
  testID,
  ...props
}: any) =>
  createElement(
    "button",
    {
      ...props,
      role: accessibilityRole ?? "button",
      "aria-label": accessibilityLabel,
      "data-rn-shim": testID,
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
    },
    children,
  );

mock.module("react-native", () => createReactNativeMock({ Pressable, View }));
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

const { ChatSessionList } = await import("../ChatSessionList");

const session = (id: string, name: string, hours = 2) => ({
  id,
  name,
  inferredName: "",
  createdAt: 0,
  activity: Date.now() - hours * 3600_000,
  lastActiveAt: hoursAgo(hours),
  isPinned: false,
  isArchived: false,
});

const handlers = () => ({
  onSelect: mock((_id: string) => {}),
  onTogglePin: mock((_id: string, _next: boolean) => {}),
  onRename: mock((_id: string, _name: string) => {}),
  onToggleArchive: mock((_id: string, _next: boolean) => {}),
  onDeleteChat: mock((_id: string) => {}),
});

function renderList(overrides: Record<string, unknown> = {}) {
  const spies = handlers();
  render(
    <ChatSessionList
      sessions={[]}
      emptyLabel="No chats yet"
      scopeLabel="Project one"
      {...spies}
      {...(overrides as any)}
    />,
  );
  return spies;
}

beforeEach(() => {
  cleanup();
});

describe("ChatSessionList", () => {
  test("a workspace-pane row carries the spinner, the activity dot, the relative time and the overflow menu", () => {
    renderList({
      variant: "workspacePane",
      activeChatId: "a",
      streamingIds: new Set(["a"]),
      completedIds: new Set(["b"]),
      sessions: [session("a", "Alpha", 2), session("b", "Bravo", 3)],
    });

    expect(screen.getByLabelText("Chat running")).toBeTruthy();
    expect(screen.getByLabelText("Chat has new activity")).toBeTruthy();
    expect(screen.getByText("2h ago")).toBeTruthy();
    expect(screen.getByText("3h ago")).toBeTruthy();
    expect(screen.getByLabelText("Manage Alpha")).toBeTruthy();
    expect(screen.getByLabelText("Chat: Alpha")).toBeTruthy();
  });

  test("a row is not streaming unless its id is in streamingIds", () => {
    renderList({
      variant: "workspacePane",
      streamingIds: new Set(["other"]),
      sessions: [session("a", "Alpha")],
    });
    expect(screen.queryByLabelText("Chat running")).toBeNull();
    expect(screen.queryByLabelText("Chat has new activity")).toBeNull();
  });

  test("the header action renders as a list row and fires", () => {
    const onPress = mock(() => {});
    renderList({
      sessions: [],
      headerAction: {
        label: "New chat",
        accessibilityLabel: "New chat",
        icon: null,
        onPress,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("a busy header action does not fire", () => {
    const onPress = mock(() => {});
    renderList({
      sessions: [],
      headerAction: {
        label: "New chat",
        accessibilityLabel: "New chat",
        icon: null,
        onPress,
        busy: true,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onPress).not.toHaveBeenCalled();
  });

  test("the empty list shows the caller's copy, and a loading list says loading", () => {
    renderList({ sessions: [], emptyLabel: "Your chats show up here." });
    expect(screen.getByText("Your chats show up here.")).toBeTruthy();
    cleanup();
    renderList({ sessions: [], loaded: false });
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  test("the Archived chevron expands the archived rows and shows the count", () => {
    renderList({
      sessions: [session("a", "Alpha")],
      archivedSessions: [{ ...session("z", "Zulu"), isArchived: true }],
    });

    expect(screen.getByLabelText("Expand archived chats")).toBeTruthy();
    expect(screen.queryByLabelText("Chat: Zulu")).toBeNull();

    fireEvent.click(screen.getByLabelText("Expand archived chats"));

    expect(screen.getByLabelText("Collapse archived chats")).toBeTruthy();
    expect(screen.getByLabelText("Chat: Zulu")).toBeTruthy();
  });

  test("Show more pages 5 → 15 → 20 and then offers See all", () => {
    const sessions = Array.from({ length: 30 }, (_, index) =>
      session(`chat-${index}`, `Chat ${index}`, index + 1),
    );
    const onSeeAll = mock(() => {});
    renderList({ sessions, onSeeAll });

    const rows = () => screen.getAllByLabelText(/^Chat: /).length;
    expect(rows()).toBe(5);

    fireEvent.click(screen.getByLabelText("Show more chats for Project one"));
    expect(rows()).toBe(15);

    fireEvent.click(screen.getByLabelText("Show more chats for Project one"));
    expect(rows()).toBe(20);

    fireEvent.click(screen.getByLabelText("See all chats for Project one"));
    expect(onSeeAll).toHaveBeenCalledTimes(1);
  });

  test("server paging offers See all immediately when the caller has more", () => {
    renderList({
      sessions: [session("a", "Alpha")],
      hasMore: true,
      onSeeAll: mock(() => {}),
    });
    expect(screen.getByLabelText("See all chats for Project one")).toBeTruthy();
  });

  test("renderAll lists every chat and offers no paging row", () => {
    const sessions = Array.from({ length: 30 }, (_, index) =>
      session(`chat-${index}`, `Chat ${index}`, index + 1),
    );
    const onSeeAll = mock(() => {});
    renderList({ sessions, onSeeAll, renderAll: true });

    expect(screen.getAllByLabelText(/^Chat: /).length).toBe(30);
    expect(screen.queryByLabelText("Show more chats for Project one")).toBeNull();
    expect(screen.queryByLabelText("See all chats for Project one")).toBeNull();
  });

  test("deleting a chat goes through the in-app dialog, never window.confirm", () => {
    const confirm = mock(() => true);
    (globalThis as any).window = globalThis.window ?? ({} as any);
    (globalThis.window as any).confirm = confirm;

    const spies = renderList({ sessions: [session("a", "Alpha")] });

    fireEvent.click(screen.getByLabelText("Manage Alpha"));
    fireEvent.click(screen.getByLabelText("menu Delete"));

    expect(screen.getByText("Delete chat")).toBeTruthy();
    expect(
      screen.getByText('Permanently delete "Alpha"? This can\'t be undone.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Delete"));

    expect(spies.onDeleteChat).toHaveBeenCalledWith("a");
    expect(confirm).not.toHaveBeenCalled();
  });

  test("row and label class overrides reach the row (phone drawer keeps its own type scale)", () => {
    renderList({
      sessions: [session("a", "Alpha")],
      rowClassName: "min-h-0 rounded-xl px-3 py-1.5",
      textClassName: "text-base font-medium",
      inactiveTextClassName: "text-foreground",
    });

    const row = screen.getByLabelText("Chat: Alpha");
    expect(row.className).toContain("rounded-xl");
    const label = Array.from(row.querySelectorAll("*")).find(
      (node) => node.textContent === "Alpha",
    );
    expect(label?.getAttribute("class")).toContain("text-base");
    expect(label?.getAttribute("class")).toContain("text-foreground");
  });

  test("cancelling the dialog deletes nothing", () => {
    const spies = renderList({ sessions: [session("a", "Alpha")] });

    fireEvent.click(screen.getByLabelText("Manage Alpha"));
    fireEvent.click(screen.getByLabelText("menu Delete"));
    fireEvent.click(screen.getByLabelText("Cancel"));

    expect(spies.onDeleteChat).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete chat")).toBeNull();
  });
});
