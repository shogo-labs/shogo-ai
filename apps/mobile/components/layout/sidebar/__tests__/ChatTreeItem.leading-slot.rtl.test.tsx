// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-190: the leading slot answers "what is this row doing" in one place —
 * running › unread › pinned › idle — in every variant and every density. A
 * pinned chat used to be invisible on a phone row (the pin was gated on
 * `!comfortable`) and on the workspace pane it could never appear at all.
 */
import { resolve } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

let phoneLayout = false;

const Icon = ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
  createElement("span", { "aria-label": accessibilityLabel });

// Renders the RN `accessibilityLabel` as the aria-label the query can find.
const View = ({ accessibilityLabel, children, ...props }: any) =>
  createElement(
    "div",
    { ...props, "aria-label": accessibilityLabel },
    children,
  );

mock.module("react-native", () => createReactNativeMock({ View } as any));
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
mock.module("lucide-react-native", () => ({
  Archive: Icon,
  ArchiveRestore: Icon,
  Check: Icon,
  Loader2: Icon,
  MoreHorizontal: Icon,
  Pencil: Icon,
  Pin: Icon,
  PinOff: Icon,
  Trash2: Icon,
  X: Icon,
}));
mock.module(
  resolve(import.meta.dir, "../../../phone/NativePhoneSheet"),
  () => ({ NativePhoneSheet: () => null }),
);
mock.module(resolve(import.meta.dir, "../../SidebarContextMenu"), () => ({
  SidebarContextMenu: () => null,
}));
mock.module(
  resolve(import.meta.dir, "../../../../lib/native-phone-layout"),
  () => ({
    isNativePlatform: () => false,
    isPhoneLayout: () => phoneLayout,
    useIsNativePhoneLayout: () => phoneLayout,
    usePhoneLayout: () => phoneLayout,
  }),
);

const { ChatTreeItem } = await import("../ChatTreeItem");

function renderRow(
  session: Record<string, unknown>,
  props: Record<string, unknown> = {},
) {
  render(
    <ChatTreeItem
      session={{
        id: "chat-1",
        name: "Birthday party",
        isPinned: false,
        isArchived: false,
        lastActiveAt: "2026-10-01T10:00:00.000Z",
        ...session,
      }}
      onSelect={() => {}}
      onTogglePin={() => {}}
      onRename={() => {}}
      onToggleArchive={() => {}}
      onRequestDelete={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  cleanup();
  phoneLayout = false;
});

describe("ChatTreeItem leading slot", () => {
  test("workspace pane: a pinned idle row shows a pin, not a bare dot", () => {
    renderRow({ isPinned: true }, { variant: "workspacePane" });
    expect(screen.getByLabelText("Pinned")).toBeTruthy();
  });

  test("workspace pane: running beats the pin", () => {
    renderRow({ isPinned: true }, { variant: "workspacePane", isStreaming: true });
    expect(screen.getByLabelText("Chat running")).toBeTruthy();
    expect(screen.queryByLabelText("Pinned")).toBeNull();
  });

  test("workspace pane: unread beats the pin", () => {
    renderRow({ isPinned: true }, { variant: "workspacePane", isCompleted: true });
    expect(screen.getByLabelText("Chat has new activity")).toBeTruthy();
    expect(screen.queryByLabelText("Pinned")).toBeNull();
  });

  test("workspace pane: an idle unpinned row keeps its neutral dot", () => {
    renderRow({}, { variant: "workspacePane" });
    expect(screen.queryByLabelText("Pinned")).toBeNull();
    expect(screen.queryByLabelText("Chat running")).toBeNull();
    expect(screen.queryByLabelText("Chat has new activity")).toBeNull();
  });

  test("phone density: a pinned row shows the pin too", () => {
    phoneLayout = true;
    renderRow({ isPinned: true });
    expect(screen.getByLabelText("Pinned")).toBeTruthy();
  });

  test("phone density: running and unread still win over the pin", () => {
    phoneLayout = true;
    renderRow({ isPinned: true }, { isStreaming: true });
    expect(screen.getByLabelText("Chat running")).toBeTruthy();
    expect(screen.queryByLabelText("Pinned")).toBeNull();

    cleanup();
    renderRow({ isPinned: true }, { isCompleted: true });
    expect(screen.getByLabelText("Chat has new activity")).toBeTruthy();
    expect(screen.queryByLabelText("Pinned")).toBeNull();
  });
});
