// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A chats GET that fails is an error, not an empty project (SHO-582).
 *
 * On a CPU-starved first paint the sidebar's chats request died as a
 * `ShogoError` and the list rendered "No chats yet" over it — the person is
 * told their chats are gone, and nothing offers to fetch them again.
 */

import { resolve } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import React, { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

/** Flipped per test: the chats request fails until it is allowed to answer. */
let failChats = true;
const chatRows = [
  {
    id: "chat-1",
    name: "Chat Alpha",
    contextId: "project-1",
    isPinned: false,
    isArchived: false,
    updatedAt: Date.now(),
  },
];

const fetchProjectChatSessions = mock(async () => {
  if (failChats) throw new Error("The request timed out after 20000 ms");
  return { sessions: chatRows, hasMore: false, total: chatRows.length };
});

mock.module("react-native", () => createReactNativeMock());
mock.module("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  usePathname: () => "/projects/project-1",
  useRouter: () => ({
    push: mock(() => {}),
    setParams: mock(() => {}),
  }),
}));
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
mock.module(resolve(import.meta.dir, "../../../../contexts/domain"), () => ({
  useDomainActions: () => ({
    updateChatSession: mock(async () => {}),
    deleteChatSession: mock(async () => {}),
    updateProject: mock(async () => {}),
    deleteProject: mock(async () => {}),
  }),
  useDomainHttp: () => ({}),
  useDomainHttpOptional: () => ({}),
  getDomainHttpClient: () => ({}),
}));
mock.module(resolve(import.meta.dir, "../../../../lib/api"), () => ({
  api: {
    prewarmProjectRuntime: mock(async () => {}),
  },
}));
mock.module(
  resolve(import.meta.dir, "../../../../lib/project-chat-sessions"),
  () => ({
    fetchProjectChatSessions,
    PROJECT_CHAT_PAGE_SIZE: 25,
    projectChatLabel: (session: { name?: string }) => session.name ?? "",
    visibleProjectChatItems: (sessions: unknown[]) => sessions,
  }),
);
mock.module(
  resolve(import.meta.dir, "../../../../lib/native-phone-layout"),
  () => ({
    isNativePlatform: () => false,
    isPhoneLayout: () => false,
    useIsNativePhoneLayout: () => false,
    usePhoneLayout: () => false,
  }),
);
mock.module("lucide-react-native", () => {
  const Icon = () => null;
  return {
    Archive: Icon,
    ArchiveRestore: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Folder: Icon,
    Lock: Icon,
    Pencil: Icon,
    Pin: Icon,
    PinOff: Icon,
    Plus: Icon,
    Trash2: Icon,
    UserPlus: Icon,
    X: Icon,
  };
});
mock.module(resolve(import.meta.dir, "../ChatTreeItem"), () => ({
  ChatTreeItem: ({ session }: { session: { id: string; name?: string } }) =>
    createElement("button", { type: "button" }, session.name),
}));
mock.module(resolve(import.meta.dir, "../../SidebarContextMenu"), () => ({
  SidebarContextMenu: () => null,
}));
mock.module(resolve(import.meta.dir, "../NativeProjectActionsSheet"), () => ({
  NativeProjectActionsSheet: () => null,
}));

const { ProjectTreeItem } = await import("../ProjectTreeItem");

describe("ProjectTreeItem chats request failure", () => {
  test('shows a retryable error, never "No chats yet"', async () => {
    failChats = true;
    fetchProjectChatSessions.mockClear();
    // Keep the console clean: the catch logs the failure on purpose.
    const logged = mock(() => {});
    const originalError = console.error;
    console.error = logged;
    try {
      render(
        <ProjectTreeItem
          project={{ id: "project-1", name: "Project one" }}
          mobileProjectDetail
        />,
      );

      await screen.findByText("Couldn't load chats.");
      expect(screen.queryByText("No chats yet")).toBeNull();

      // Retry re-fetches and the real rows replace the error.
      failChats = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("button", { name: "Chat Alpha" });
      expect(fetchProjectChatSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
      await waitFor(() =>
        expect(screen.queryByText("Couldn't load chats.")).toBeNull(),
      );
    } finally {
      console.error = originalError;
    }
  });
});
