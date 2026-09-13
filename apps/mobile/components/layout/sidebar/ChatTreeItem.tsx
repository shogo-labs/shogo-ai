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
import { projectChatLabel } from "../../../lib/project-chat-sessions";

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
}) {
  const isNative = Platform.OS !== "web";
  const density = densityFor(isNative);
  const label = projectChatLabel(session);
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
    [onMeasureHeight],
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
          isNative ? `${density.rowMin} gap-2 px-2 py-1.5` : "gap-1 px-1 py-1",
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
            isNative ? `${density.text.body} h-11` : "h-6 text-xs",
          )}
        />
        <Pressable
          onPress={saveEdit}
          className="p-0.5"
          accessibilityLabel="Save name"
        >
          <Check
            size={isNative ? density.icon.md : 12}
            className="text-primary"
          />
        </Pressable>
        <Pressable
          onPress={() => setEditing(false)}
          className="p-0.5"
          accessibilityLabel="Cancel rename"
        >
          <X
            size={isNative ? density.icon.md : 12}
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
          isNative ? `${density.rowMin} gap-2 px-2 py-2` : "gap-1 px-1 py-1.5",
          active ? "bg-accent" : "active:bg-accent/50",
        )}
        {...(Platform.OS === "web"
          ? ({ onContextMenu: handleContextMenu } as any)
          : {})}
      >
        {isStreaming ? (
          <Loader2
            size={isNative ? density.icon.sm + 1 : 11}
            className="text-primary animate-spin shrink-0"
            accessibilityLabel="Chat running"
          />
        ) : isCompleted ? (
          <View
            className="h-1.5 w-1.5 rounded-full bg-primary shrink-0"
            accessibilityLabel="Chat has new activity"
          />
        ) : session.isPinned && !isNative ? (
          <Pin
            size={isNative ? density.icon.sm : 10}
            className="text-muted-foreground shrink-0"
          />
        ) : null}
        <Text
          className={cn(
            isNative ? `${density.text.body} flex-1` : "text-xs flex-1",
            active ? "text-foreground" : "text-muted-foreground",
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
        {/* Hover-reveal actions (web). Always mounted; visibility is purely
          CSS-driven via the row's `group` + `group-hover:flex` so moving the
          cursor between icons never tears down the hover target. */}
        {!isNative && (
        <View className="hidden group-hover:flex flex-row items-center gap-0.5 shrink-0">
          <Pressable
            onPress={(e) => {
              stop(e);
              onTogglePin(session.id, !session.isPinned);
            }}
            className="p-0.5"
            accessibilityLabel={
              session.isPinned ? `Unpin ${label}` : `Pin ${label}`
            }
          >
            {session.isPinned ? (
              <PinOff size={11} className="text-muted-foreground" />
            ) : (
              <Pin size={11} className="text-muted-foreground" />
            )}
          </Pressable>
          <Pressable
            onPress={(e) => {
              stop(e);
              onToggleArchive(session.id, !session.isArchived);
            }}
            className="p-0.5"
            accessibilityLabel={
              session.isArchived ? `Unarchive ${label}` : `Archive ${label}`
            }
          >
            {session.isArchived ? (
              <ArchiveRestore size={11} className="text-muted-foreground" />
            ) : (
              <Archive size={11} className="text-muted-foreground" />
            )}
          </Pressable>
          <Pressable
            onPress={(e) => {
              stop(e);
              startEdit();
            }}
            className="p-0.5"
            accessibilityLabel={`Rename ${label}`}
          >
            <Pencil size={11} className="text-muted-foreground" />
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
