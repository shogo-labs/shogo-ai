// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import React, { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

let pathname = "/projects/project-1";

const updateChatSession = mock(async () => {});
const fetchProjectChatSessions = mock(async () => ({
  sessions: [
    {
      id: "chat-1",
      name: "Original name",
      contextId: "project-1",
      isPinned: false,
      isArchived: false,
      updatedAt: Date.now(),
    },
  ],
  hasMore: false,
}));

mock.module("react-native", () => createReactNativeMock());
mock.module("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  usePathname: () => pathname,
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
    updateChatSession,
    deleteChatSession: mock(async () => {}),
    updateProject: mock(async () => {}),
    deleteProject: mock(async () => {}),
  }),
  useDomainHttp: () => ({}),
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
    X: Icon,
  };
});
mock.module(resolve(import.meta.dir, "../ChatTreeItem"), () => ({
  ChatTreeItem: ({
    session,
    active,
    onRename,
  }: {
    session: { id: string; name?: string };
    active?: boolean;
    onRename: (id: string, name: string) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-active": String(!!active),
        onClick: () => onRename(session.id, "Renamed name"),
      },
      session.name,
    ),
}));
mock.module(resolve(import.meta.dir, "../../SidebarContextMenu"), () => ({
  SidebarContextMenu: () => null,
}));
mock.module(resolve(import.meta.dir, "../NativeProjectActionsSheet"), () => ({
  NativeProjectActionsSheet: () => null,
}));

const { ProjectTreeItem } = await import("../ProjectTreeItem");
const { chatSessionEvents } =
  await import("../../../../lib/chat-session-events");

describe("ProjectTreeItem chat synchronization", () => {
  test("refetches on refresh events and emits after an inline rename", async () => {
    fetchProjectChatSessions.mockClear();
    updateChatSession.mockClear();

    render(
      <ProjectTreeItem
        project={{ id: "project-1", name: "Project one" }}
        mobileProjectDetail
      />,
    );

    await screen.findByRole("button", { name: "Original name" });
    expect(fetchProjectChatSessions).toHaveBeenCalledTimes(1);

    chatSessionEvents.emit({ projectId: "project-1", refresh: true });
    await waitFor(() =>
      expect(fetchProjectChatSessions).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Original name" }));
    await waitFor(() =>
      expect(updateChatSession).toHaveBeenCalledWith("chat-1", {
        name: "Renamed name",
      }),
    );
    await waitFor(() =>
      expect(fetchProjectChatSessions).toHaveBeenCalledTimes(3),
    );
  });

  test("drops the active chat highlight when the project is no longer open", async () => {
    pathname = "/projects/project-1";
    const view = render(
      <ProjectTreeItem
        project={{ id: "project-1", name: "Project one" }}
        mobileProjectDetail
      />,
    );

    await screen.findByRole("button", { name: "Original name" });
    chatSessionEvents.emit({ projectId: "project-1", activeSessionId: "chat-1" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Original name" })
          .getAttribute("data-active"),
      ).toBe("true"),
    );

    pathname = "/projects/project-2";
    view.rerender(
      <ProjectTreeItem
        project={{ id: "project-1", name: "Project one" }}
        mobileProjectDetail
      />,
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Original name" })
          .getAttribute("data-active"),
      ).toBe("false"),
    );
  });
});
