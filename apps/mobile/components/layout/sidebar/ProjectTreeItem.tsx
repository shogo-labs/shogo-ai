// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { observer } from "mobx-react-lite";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useDomainActions, useDomainHttp } from "../../../contexts/domain";
import { api } from "../../../lib/api";
import { defaultTabForProject } from "../../../lib/project-preview-tab";
import {
  fetchProjectChatSessions,
  PROJECT_CHAT_PAGE_SIZE,
  projectChatLabel,
  visibleProjectChatItems,
  type ProjectChatListItem,
} from "../../../lib/project-chat-sessions";
import {
  chatActivityEvents,
  chatSessionEvents,
} from "../../../lib/chat-session-events";
import { densityFor } from "../../../lib/phone-density";
import {
  SidebarContextMenu,
  type SidebarMenuEntry,
} from "../SidebarContextMenu";
import { ChatTreeItem } from "./ChatTreeItem";
import { NativeProjectActionsSheet } from "./NativeProjectActionsSheet";

// ─── ProjectTreeItem (a project + its nested chats) ─────────

// Cap the per-project chat scroll area to 5 visible chat rows.
const MAX_VISIBLE_CHATS = 5;
const ARCHIVED_CHAT_ROW_ID = "archived-chats" as const;
const SIDEBAR_CHAT_SCROLL_DATASET = { sidebarChatScroll: "true" } as const;
const SIDEBAR_CHAT_SCROLL_CONTENT_STYLE = { paddingRight: 2 } as const;
const SIDEBAR_CHAT_WEB_SCROLL_STYLE = {
  minHeight: 0,
  maxWidth: "100%",
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
} as const;

type SidebarChatRow =
  | { type: "chat"; id: string; session: any }
  | { type: "archived-header"; id: typeof ARCHIVED_CHAT_ROW_ID };

function createSidebarChatRows(
  activeSessions: any[],
  archivedSessions: any[],
  archivedExpanded: boolean,
): SidebarChatRow[] {
  const rows: SidebarChatRow[] = activeSessions.map((session: any) => ({
    type: "chat",
    id: session.id,
    session,
  }));

  if (archivedSessions.length > 0) {
    rows.push({ type: "archived-header", id: ARCHIVED_CHAT_ROW_ID });
  }

  if (archivedExpanded) {
    rows.push(
      ...archivedSessions.map((session: any) => ({
        type: "chat" as const,
        id: session.id,
        session,
      })),
    );
  }

  return rows;
}

function getSidebarChatScrollStyle(
  chatRowHeight: number | null,
  rowCount: number,
) {
  const maxHeight =
    chatRowHeight && rowCount > MAX_VISIBLE_CHATS
      ? chatRowHeight * MAX_VISIBLE_CHATS
      : undefined;

  return Platform.OS === "web"
    ? { ...SIDEBAR_CHAT_WEB_SCROLL_STYLE, maxHeight }
    : { maxHeight };
}

export const ProjectTreeItem = observer(function ProjectTreeItem({
  project,
  collapsed,
  onNavPress,
  isPinned,
  onTogglePin,
  mobileProjectFirstTapShowsChats,
}: {
  project: any;
  collapsed?: boolean;
  onNavPress?: () => void;
  isPinned?: boolean;
  onTogglePin?: (projectId: string, next: boolean) => void;
  mobileProjectFirstTapShowsChats?: boolean;
}) {
  const router = useRouter();
  const isNative = Platform.OS !== "web";
  const density = densityFor(isNative);
  const pathname = usePathname();
  const params = useLocalSearchParams<{ chatSessionId?: string }>();
  const http = useDomainHttp();
  const actions = useDomainActions();
  const [expanded, setExpanded] = useState(false);
  // Chats are fetched directly into local state (rather than the shared
  // chat-session collection) because the collection's loaders prune items
  // from other contexts — expanding a second project would otherwise wipe
  // the first project's chats out of the cache.
  const [sessions, setSessions] = useState<ProjectChatListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [chatRowHeight, setChatRowHeight] = useState<number | null>(null);
  const seededRef = useRef(false);
  // Collapsible "Archived" subsection (in-memory; defaults to collapsed).
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // Live streaming / new-activity state mirrored from the open project
  // workspace (the only one mounted) via the activity event bus.
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  // Inline project rename state (mirrors ChatTreeItem's editor).
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  // Web-only right-click menu anchor (viewport coords) for the project row.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [nativeActionsOpen, setNativeActionsOpen] = useState(false);
  // Delete confirmation, shared by this project and its chats.
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: "project" | "chat";
    id: string;
    label: string;
  } | null>(null);

  const isActive = pathname.includes(project.id);
  const routeChatId = Array.isArray(params.chatSessionId)
    ? params.chatSessionId[0]
    : params.chatSessionId;
  // The project workspace selects new chats via local state (no URL change),
  // so the route param alone can't tell us which chat is active. An override,
  // fed by chat-session events, keeps the highlight in sync.
  const [activeOverride, setActiveOverride] = useState<string | undefined>(
    routeChatId,
  );
  const activeChatId = activeOverride ?? routeChatId;

  useEffect(() => {
    if (routeChatId) setActiveOverride(routeChatId);
  }, [routeChatId]);

  const loadChats = useCallback(
    async (limit = PROJECT_CHAT_PAGE_SIZE) => {
      const loadingMore = limit > PROJECT_CHAT_PAGE_SIZE;
      if (!http) return;
      if (!loadingMore) {
        if (seededRef.current) return;
        seededRef.current = true;
      } else {
        if (!hasMoreChats || loadingMoreChats) return;
        setLoadingMoreChats(true);
      }
      try {
        const result = await fetchProjectChatSessions(http, project.id, limit);
        setSessions(result.sessions);
        setHasMoreChats(result.hasMore);
      } catch (e) {
        console.error("[AppSidebar] Failed to load chats:", e);
        if (!loadingMore) seededRef.current = false;
      } finally {
        setLoaded(true);
        if (loadingMore) setLoadingMoreChats(false);
      }
    },
    [hasMoreChats, http, loadingMoreChats, project.id],
  );

  const handleChatRowHeight = useCallback((height: number) => {
    setChatRowHeight((current) => {
      const next = Math.ceil(height);
      return current === next ? current : next;
    });
  }, []);

  // Force a re-fetch even if this project's chats were already seeded.
  const refreshChats = useCallback(() => {
    seededRef.current = false;
    setHasMoreChats(false);
    setLoadingMoreChats(false);
    void loadChats();
  }, [loadChats]);

  const handleChatScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!hasMoreChats || loadingMoreChats) return;
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromBottom <= 24)
        void loadChats(sessions.length + PROJECT_CHAT_PAGE_SIZE);
    },
    [hasMoreChats, loadingMoreChats, loadChats, sessions.length],
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next) void loadChats();
      return next;
    });
  }, [loadChats]);

  // The project workspace creates / renames / deletes chats and switches the
  // active chat without touching this sidebar's local state or the URL. Listen
  // so the tree re-fetches (on create/rename/delete) and always re-highlights
  // the active chat immediately.
  useEffect(() => {
    return chatSessionEvents.subscribe(
      ({ projectId, activeSessionId, refresh }) => {
        if (projectId !== project.id) return;
        if (refresh) {
          if (!mobileProjectFirstTapShowsChats) setExpanded(true);
          refreshChats();
        }
        if (activeSessionId) setActiveOverride(activeSessionId);
      },
    );
  }, [project.id, refreshChats, mobileProjectFirstTapShowsChats]);

  // Mirror the open workspace's live streaming / new-activity state so chat
  // rows can show a spinner / activity dot. Decoupled from the refresh events
  // above so a stream tick never triggers a chat-list re-fetch.
  useEffect(() => {
    return chatActivityEvents.subscribe(
      ({ projectId, streamingSessionIds, completedSessionIds }) => {
        if (projectId !== project.id) return;
        setStreamingIds(new Set(streamingSessionIds));
        setCompletedIds(new Set(completedSessionIds));
      },
    );
  }, [project.id]);

  // When this project is the one open in the content pane, reveal its chats
  // automatically so the active chat is visible without a manual expand.
  useEffect(() => {
    if (mobileProjectFirstTapShowsChats) return;
    if (isActive && !collapsed) {
      setExpanded(true);
      void loadChats();
    }
  }, [isActive, collapsed, loadChats, mobileProjectFirstTapShowsChats]);

  const openProject = useCallback(() => {
    void api.prewarmProjectRuntime(http, project.id);
    // Clicking a project name is an explicit "take me to this project's main
    // surface" intent: Canvas for canvas-capable projects, fullscreen Chat
    // for chat-only agents, the external preview for folder-linked projects.
    // Native phone always lands on Chat — the user can switch to Canvas after
    // open. We pass it as a `tab` param the project layout applies (with
    // precedence over the saved last-tab). `tabNonce` forces re-application
    // when the project is already open and the tab value is unchanged.
    const tab = mobileProjectFirstTapShowsChats
      ? "chat-fullscreen"
      : defaultTabForProject(project);
    if (!isActive) {
      router.push({
        pathname: "/(app)/projects/[id]",
        params: { id: project.id, tab },
      } as any);
    } else {
      // Already on this project — re-pushing remounts the workspace and
      // flashes, so switch the tab in place via params instead.
      router.setParams({ tab, tabNonce: String(Date.now()) } as any);
    }
    onNavPress?.();
  }, [router, project, onNavPress, isActive, mobileProjectFirstTapShowsChats, http]);

  const handleProjectPress = useCallback(() => {
    if (mobileProjectFirstTapShowsChats) {
      router.push({
        pathname: "/(app)/project-chats",
        params: { id: project.id },
      } as any);
      onNavPress?.();
      return;
    }
    openProject();
  }, [
    mobileProjectFirstTapShowsChats,
    onNavPress,
    openProject,
    project.id,
    router,
  ]);

  // Select a chat. If its project is already open, switch IN PLACE via the
  // event bus (no navigation / remount). Otherwise navigate to the project
  // with the chat deep-linked.
  const handleSelectChat = useCallback(
    (sessionId: string) => {
      if (sessionId === activeChatId) {
        onNavPress?.();
        return;
      }
      if (isActive) {
        setActiveOverride(sessionId);
        chatSessionEvents.requestSelect({ projectId: project.id, sessionId });
      } else {
        router.push({
          pathname: "/(app)/projects/[id]",
          params: { id: project.id, chatSessionId: sessionId },
        } as any);
      }
      onNavPress?.();
    },
    [activeChatId, isActive, project.id, router, onNavPress],
  );

  // Create a new chat for this project and land on it. Session creation
  // (workspace-runtime vs project scope) is non-trivial and lives in the
  // project layout's `handleCreateNewSession`, so reuse it: when the project
  // is already open, ask it to mint one in place via the event bus; otherwise
  // navigate in with a one-shot `newChat` param the layout consumes on mount.
  const handleCreateChat = useCallback(() => {
    if (isActive) {
      setExpanded(true);
      chatSessionEvents.requestNewChat({ projectId: project.id });
    } else {
      router.push({
        pathname: "/(app)/projects/[id]",
        params: {
          id: project.id,
          newChat: "1",
          newChatNonce: String(Date.now()),
        },
      } as any);
    }
    onNavPress?.();
  }, [isActive, project.id, router, onNavPress]);

  // Pin / rename / archive operate against the domain collection and update
  // local state optimistically (the sidebar fetches chats over HTTP, so it
  // isn't auto-synced to the collection). On failure we re-fetch to reconcile.
  const handleTogglePin = useCallback(
    async (sessionId: string, next: boolean) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, isPinned: next } : s)),
      );
      try {
        await actions.updateChatSession(sessionId, { isPinned: next });
      } catch (e) {
        console.error("[AppSidebar] Failed to toggle pin:", e);
        refreshChats();
      }
    },
    [actions, refreshChats],
  );

  const handleToggleArchive = useCallback(
    async (sessionId: string, next: boolean) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, isArchived: next } : s)),
      );
      try {
        await actions.updateChatSession(sessionId, { isArchived: next });
      } catch (e) {
        console.error("[AppSidebar] Failed to toggle archive:", e);
        refreshChats();
      }
    },
    [actions, refreshChats],
  );

  const handleRename = useCallback(
    async (sessionId: string, name: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, name } : s)),
      );
      try {
        await actions.updateChatSession(sessionId, { name });
      } catch (e) {
        console.error("[AppSidebar] Failed to rename chat:", e);
        refreshChats();
      }
    },
    [actions, refreshChats],
  );

  // Delete a chat: drop it locally first, reconcile on failure. The owning
  // project handles the confirm flow, so this runs only after confirmation.
  const handleDeleteChat = useCallback(
    async (sessionId: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      try {
        await actions.deleteChatSession(sessionId);
      } catch (e) {
        console.error("[AppSidebar] Failed to delete chat:", e);
        refreshChats();
      }
    },
    [actions, refreshChats],
  );

  // Inline project rename. The project row is a MobX observer over the project
  // collection, so updateProject's optimistic write re-renders the new name.
  const startEditProject = useCallback(() => {
    setEditValue(project.name || "");
    setEditing(true);
  }, [project.name]);

  const saveEditProject = useCallback(async () => {
    const trimmed = editValue.trim();
    setEditing(false);
    if (!trimmed || trimmed === (project.name || "")) return;
    try {
      await actions.updateProject(project.id, { name: trimmed });
    } catch (e) {
      console.error("[AppSidebar] Failed to rename project:", e);
    }
  }, [editValue, project.id, project.name, actions]);

  const handleContextMenu = useCallback((e: any) => {
    e?.preventDefault?.();
    const ne = e?.nativeEvent ?? e;
    setMenu({ x: ne?.clientX ?? 0, y: ne?.clientY ?? 0 });
  }, []);

  const openNativeActions = useCallback(() => {
    if (isNative) setNativeActionsOpen(true);
  }, [isNative]);

  const requestProjectDelete = useCallback(() => {
    setConfirmDelete({
      kind: "project",
      id: project.id,
      label: project.name || "Untitled",
    });
  }, [project.id, project.name]);

  // Run the confirmed delete for either the project or one of its chats.
  const performDelete = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    if (target.kind === "chat") {
      await handleDeleteChat(target.id);
      return;
    }
    try {
      await actions.deleteProject(target.id);
    } catch (e) {
      console.error("[AppSidebar] Failed to delete project:", e);
    }
  }, [confirmDelete, handleDeleteChat, actions]);

  if (collapsed) {
    return "";
  }

  const projectMenuItems: SidebarMenuEntry[] = [
    {
      label: "New chat",
      icon: <Plus size={14} className="text-muted-foreground" />,
      onSelect: handleCreateChat,
    },
    {
      label: "Rename",
      icon: <Pencil size={14} className="text-muted-foreground" />,
      onSelect: startEditProject,
    },
    {
      label: isPinned ? "Unpin" : "Pin",
      icon: isPinned ? (
        <PinOff size={14} className="text-muted-foreground" />
      ) : (
        <Pin size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onTogglePin?.(project.id, !isPinned),
    },
    { separator: true },
    {
      label: "Delete",
      danger: true,
      icon: <Trash2 size={14} className="text-destructive" />,
      onSelect: requestProjectDelete,
    },
  ];

  return (
    <View>
      {editing ? (
        <View
          className={cn(
            "flex-row items-center rounded-md px-2",
            isNative ? `${density.rowMin} gap-2 py-1.5` : "gap-1.5 py-1.5",
          )}
        >
          <Folder
            size={isNative ? density.icon.md : 12}
            className="text-muted-foreground"
          />
          <TextInput
            value={editValue}
            onChangeText={setEditValue}
            onSubmitEditing={saveEditProject}
            onBlur={saveEditProject}
            autoFocus
            selectTextOnFocus
            className={cn(
              "flex-1 px-2 rounded border border-border bg-background text-foreground",
              isNative ? `h-11 ${density.text.body}` : "h-6 text-xs",
            )}
          />
          <Pressable
            onPress={saveEditProject}
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
      ) : (
        <View
          className={cn(
            "group flex-row items-center rounded-md pr-1",
            isNative ? `${density.rowMin} gap-2 py-2` : "gap-1.5 py-1.5",
            isActive ? "bg-accent" : "active:bg-accent/50",
          )}
        >
          <Pressable
            onPress={handleProjectPress}
            onLongPress={isNative ? openNativeActions : undefined}
            delayLongPress={isNative ? 400 : undefined}
            role="link"
            accessibilityLabel={`Project: ${project.name || "Untitled"}`}
            accessibilityHint={
              mobileProjectFirstTapShowsChats
                ? "Opens chats for this project"
                : isNative
                  ? "Long press for project actions"
                  : undefined
            }
            className="flex-1 flex-row items-center gap-2 px-2 active:opacity-70 min-w-0"
            {...(Platform.OS === "web"
              ? ({ onContextMenu: handleContextMenu } as any)
              : {})}
          >
            <Folder
              size={isNative ? density.icon.md : 12}
              className={isActive ? "text-foreground" : "text-muted-foreground"}
            />
            <Text
              className={cn(
                isNative ? `${density.text.body} flex-1` : "text-xs flex-1",
                isActive ? "text-foreground" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {project.name || "Untitled"}
            </Text>
            {mobileProjectFirstTapShowsChats ? (
              <ChevronRight
                size={isNative ? density.icon.sm : 16}
                className="text-muted-foreground shrink-0"
              />
            ) : null}
          </Pressable>
          {/* Persistent pin glyph when pinned (web). Hidden on native — the
              Pinned section already groups these rows, and hover-reveal
              actions do not exist on phone. */}
          {isPinned && !isNative && (
            <View className="group-hover:hidden pr-1 shrink-0">
              <Pin size={10} className="text-muted-foreground" />
            </View>
          )}
          {/* Hover-reveal actions (web). Siblings of the project Pressable, so
              tapping one never triggers the project-open press. */}
          {!isNative && (
          <View className="hidden group-hover:flex flex-row items-center gap-0.5 shrink-0">
            <Pressable
              onPress={handleCreateChat}
              className="p-0.5"
              accessibilityLabel={`New chat in ${project.name || "Untitled"}`}
            >
              <Plus size={12} className="text-muted-foreground" />
            </Pressable>
            <Pressable
              onPress={() => onTogglePin?.(project.id, !isPinned)}
              className="p-0.5"
              accessibilityLabel={
                isPinned
                  ? `Unpin ${project.name || "Untitled"}`
                  : `Pin ${project.name || "Untitled"}`
              }
            >
              {isPinned ? (
                <PinOff size={11} className="text-muted-foreground" />
              ) : (
                <Pin size={11} className="text-muted-foreground" />
              )}
            </Pressable>
          </View>
          )}
        </View>
      )}
      {expanded &&
        !mobileProjectFirstTapShowsChats &&
        (() => {
          const activeSessions = visibleProjectChatItems(sessions);
          const archivedSessions = sessions.filter((s: any) => s.isArchived);
          const renderChat = (s: any, key = s.id) => (
            <ChatTreeItem
              key={key}
              session={s}
              active={isActive && s.id === activeChatId}
              isStreaming={streamingIds.has(s.id)}
              isCompleted={completedIds.has(s.id)}
              onSelect={handleSelectChat}
              onTogglePin={handleTogglePin}
              onRename={handleRename}
              onToggleArchive={handleToggleArchive}
              onRequestDelete={(id) =>
                setConfirmDelete({
                  kind: "chat",
                  id,
                  label: projectChatLabel(s),
                })
              }
              onMeasureHeight={handleChatRowHeight}
            />
          );
          const chatRows = createSidebarChatRows(
            activeSessions,
            archivedSessions,
            archivedExpanded,
          );
          return (
            <View className="ml-6 mt-0.5">
              {sessions.length === 0 ? (
                <View className="px-2 py-1.5">
                  <Text
                    className="text-xs text-muted-foreground opacity-70"
                    numberOfLines={1}
                  >
                    {loaded ? "No chats yet" : "Loading…"}
                  </Text>
                </View>
              ) : (
                <ScrollView
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  showsHorizontalScrollIndicator={false}
                  showsVerticalScrollIndicator={
                    chatRows.length > MAX_VISIBLE_CHATS
                  }
                  accessibilityLabel={`${project.name || "Untitled"} chats`}
                  style={
                    getSidebarChatScrollStyle(
                      chatRowHeight,
                      chatRows.length,
                    ) as any
                  }
                  contentContainerStyle={SIDEBAR_CHAT_SCROLL_CONTENT_STYLE}
                  onScroll={handleChatScroll}
                  scrollEventThrottle={64}
                  {...(Platform.OS === "web"
                    ? ({
                        dataSet: SIDEBAR_CHAT_SCROLL_DATASET,
                        tabIndex: 0,
                        role: "list",
                      } as any)
                    : {})}
                >
                  {chatRows.map((row) => {
                    if (row.type === "chat")
                      return renderChat(row.session, row.id);
                    return (
                      <Pressable
                        key={row.id}
                        onPress={() => setArchivedExpanded((v) => !v)}
                        accessibilityLabel={`${archivedExpanded ? "Collapse" : "Expand"} archived chats`}
                        accessibilityState={{ expanded: archivedExpanded }}
                        className="flex-row items-center gap-1 px-1 pt-2 pb-0.5 active:opacity-70"
                      >
                        {archivedExpanded ? (
                          <ChevronDown
                            size={10}
                            className="text-muted-foreground shrink-0"
                          />
                        ) : (
                          <ChevronRight
                            size={10}
                            className="text-muted-foreground shrink-0"
                          />
                        )}
                        <Text
                          className="text-[10px] uppercase tracking-wide text-muted-foreground flex-1"
                          numberOfLines={1}
                        >
                          Archived
                        </Text>
                        <Text className="text-[10px] text-muted-foreground shrink-0">
                          {archivedSessions.length}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {loadingMoreChats && (
                    <View className="px-2 py-1.5">
                      <Text
                        className="text-xs text-muted-foreground opacity-70"
                        numberOfLines={1}
                      >
                        Loading more…
                      </Text>
                    </View>
                  )}
                </ScrollView>
              )}
            </View>
          );
        })()}
      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={projectMenuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {isNative && (
        <NativeProjectActionsSheet
          visible={nativeActionsOpen}
          projectName={project.name || "Untitled"}
          isPinned={!!isPinned}
          onClose={() => setNativeActionsOpen(false)}
          onRename={startEditProject}
          onTogglePin={() => onTogglePin?.(project.id, !isPinned)}
          onDelete={requestProjectDelete}
        />
      )}
      <Modal
        visible={!!confirmDelete}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmDelete(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center"
          onPress={() => setConfirmDelete(null)}
        >
          <Pressable
            className="bg-card rounded-xl p-6 w-80 border border-border"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-base font-semibold text-foreground">
                {confirmDelete?.kind === "project"
                  ? "Delete project"
                  : "Delete chat"}
              </Text>
              <Pressable
                onPress={() => setConfirmDelete(null)}
                className="p-1"
                accessibilityLabel="Close"
              >
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground mb-4">
              {confirmDelete?.kind === "project"
                ? `Permanently delete "${confirmDelete?.label}" and all of its chats? This can't be undone.`
                : `Permanently delete "${confirmDelete?.label}"? This can't be undone.`}
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={performDelete}
                className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
              >
                <Text className="text-sm text-destructive-foreground">
                  Delete
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
});
