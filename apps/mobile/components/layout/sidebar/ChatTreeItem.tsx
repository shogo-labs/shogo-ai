// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from "react";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import {
  Archive,
  ArchiveRestore,
  Check,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import {
  SidebarContextMenu,
  type SidebarMenuEntry,
} from "../SidebarContextMenu";
import { densityFor } from "../../../lib/phone-density";
import { usePhoneLayout } from "../../../lib/native-phone-layout";
import { projectChatLabel } from "../../../lib/project-chat-sessions";
import { formatRelativeTime } from "../../chat/turns/turnShaping";

function sessionActivityLabel(session: any): string | null {
  const value = session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
  if (!value) return null;

  const timestamp =
    typeof value === "number" ? value : new Date(value as string).getTime();
  return Number.isFinite(timestamp) ? formatRelativeTime(timestamp) : null;
}

// ─── ChatTreeItem (a single chat nested under a project) ────

export function ChatTreeItem({
  session,
  active,
  isStreaming,
  isCompleted,
  onSelect,
  onTogglePin,
  onRename,
  onToggleArchive,
  onRequestDelete,
  onMeasureHeight,
  mobileProjectDetail,
  textClassName,
  inactiveTextClassName,
  rowClassName,
}: {
  session: any;
  active?: boolean;
  isStreaming?: boolean;
  isCompleted?: boolean;
  onSelect: (sessionId: string) => void;
  onTogglePin: (sessionId: string, next: boolean) => void;
  onRename: (sessionId: string, name: string) => void;
  onToggleArchive: (sessionId: string, next: boolean) => void;
  onRequestDelete: (sessionId: string) => void;
  onMeasureHeight?: (height: number) => void;
  /** Align detail-panel chat labels with the project name, after its folder icon. */
  mobileProjectDetail?: boolean;
  /** Override the label scale for a distinct sidebar presentation. */
  textClassName?: string;
  /** Keep conversation labels visually prominent outside the legacy tree. */
  inactiveTextClassName?: string;
  /** Override row density for a distinct sidebar presentation. */
  rowClassName?: string;
}) {
  // Viewport-based, not Platform-gated: narrow mobile web gets the same
  // comfortable row/text/icon density as the native app, not the compact
  // desktop-web sizing (that used to make chat names render tiny on phones).
  const comfortable = usePhoneLayout();
  const density = densityFor(comfortable);
  const label = projectChatLabel(session);
  const activityLabel = sessionActivityLabel(session);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  // Web-only right-click menu anchor (viewport coords).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const startEdit = useCallback(() => {
    setEditValue(label);
    setEditing(true);
  }, [label]);

  const saveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label) onRename(session.id, trimmed);
    setEditing(false);
  }, [editValue, label, session.id, onRename]);

  // Swallow the row's select press so tapping an action icon doesn't also
  // open the chat (RN-Web bubbles the nested Pressable's click to the row).
  const stop = (e: GestureResponderEvent) => e.stopPropagation?.();

  const handleContextMenu = useCallback((e: any) => {
    e?.preventDefault?.();
    const ne = e?.nativeEvent ?? e;
    setMenu({ x: ne?.clientX ?? 0, y: ne?.clientY ?? 0 });
  }, []);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (height > 0) onMeasureHeight?.(height);
    },
    [onMeasureHeight]
  );

  const menuItems: SidebarMenuEntry[] = [
    {
      label: "Rename",
      icon: <Pencil size={14} className="text-muted-foreground" />,
      onSelect: startEdit,
    },
    {
      label: session.isPinned ? "Unpin" : "Pin",
      icon: session.isPinned ? (
        <PinOff size={14} className="text-muted-foreground" />
      ) : (
        <Pin size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onTogglePin(session.id, !session.isPinned),
    },
    {
      label: session.isArchived ? "Unarchive" : "Archive",
      icon: session.isArchived ? (
        <ArchiveRestore size={14} className="text-muted-foreground" />
      ) : (
        <Archive size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onToggleArchive(session.id, !session.isArchived),
    },
    { separator: true },
    {
      label: "Delete",
      danger: true,
      icon: <Trash2 size={14} className="text-destructive" />,
      onSelect: () => onRequestDelete(session.id),
    },
  ];

  if (editing) {
    return (
      <View
        className={cn(
          "flex-row items-center rounded-md",
          comfortable
            ? `${density.rowMin} gap-2 px-2 py-1.5${
                mobileProjectDetail ? " pl-12" : ""
              }`
            : "gap-1 px-1 py-1"
        )}
      >
        <TextInput
          value={editValue}
          onChangeText={setEditValue}
          onSubmitEditing={saveEdit}
          onBlur={saveEdit}
          autoFocus
          className={cn(
            "flex-1 px-2 rounded border border-border bg-background text-foreground",
            comfortable ? `${density.text.body} h-11` : "h-6 text-xs"
          )}
        />
        <Pressable
          onPress={saveEdit}
          className="p-0.5"
          accessibilityLabel="Save name"
        >
          <Check
            size={comfortable ? density.icon.md : 12}
            className="text-primary"
          />
        </Pressable>
        <Pressable
          onPress={() => setEditing(false)}
          className="p-0.5"
          accessibilityLabel="Cancel rename"
        >
          <X
            size={comfortable ? density.icon.md : 12}
            className="text-muted-foreground"
          />
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => onSelect(session.id)}
        onLayout={handleLayout}
        role="link"
        accessibilityLabel={`Chat: ${label}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group flex-row items-center rounded-md",
          comfortable
            ? `${density.rowMin} gap-2 px-2 py-2${
                mobileProjectDetail ? " pl-12" : ""
              }`
            : "gap-1 px-1 py-1.5",
          rowClassName,
          active ? "bg-primary/10" : "active:bg-accent/50"
        )}
        {...(Platform.OS === "web"
          ? ({ onContextMenu: handleContextMenu } as any)
          : {})}
      >
        {isStreaming ? (
          <Loader2
            size={comfortable ? density.icon.sm + 1 : 11}
            className="text-primary animate-spin shrink-0"
            accessibilityLabel="Chat running"
          />
        ) : isCompleted ? (
          <View
            className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
            accessibilityLabel="Chat has new activity"
          />
        ) : session.isPinned && !comfortable ? (
          <Pin
            size={comfortable ? density.icon.sm : 10}
            className="text-muted-foreground shrink-0"
          />
        ) : null}
        <Text
          className={cn(
            textClassName ?? (comfortable ? density.text.body : "text-xs"),
            "flex-1",
            active
              ? "text-foreground"
              : inactiveTextClassName ?? "text-muted-foreground"
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
        {/* Keep secondary metadata and management controls out of the resting
          state. The one overflow menu replaces the previously exposed actions.
          Gated on web (hover-only), not on comfortable density — a touch-only
          narrow web viewport still gets no functional hover affordance here
          either way, same as before this density fix. */}
        {Platform.OS === "web" && (
          <View className="hidden group-hover:flex flex-row items-center gap-0.5 shrink-0">
            {activityLabel ? (
              <Text className="mr-1 text-[11px] text-muted-foreground">
                {activityLabel}
              </Text>
            ) : null}
            <Pressable
              onPress={(e) => {
                stop(e);
                const event = e.nativeEvent as any;
                setMenu({
                  x: event.clientX ?? event.pageX ?? 0,
                  y: event.clientY ?? event.pageY ?? 0,
                });
              }}
              className="p-0.5"
              accessibilityLabel={`Manage ${label}`}
            >
              <MoreHorizontal size={14} className="text-muted-foreground" />
            </Pressable>
          </View>
        )}
      </Pressable>
      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
