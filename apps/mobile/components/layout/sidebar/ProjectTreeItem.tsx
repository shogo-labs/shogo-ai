// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { observer } from "mobx-react-lite";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Folder,
  Lock,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useDomainActions, useDomainHttp } from "../../../contexts/domain";
import {
  projectPermissionsFor,
  usePermissions,
} from "../../../hooks/usePermissions";
import { api } from "../../../lib/api";
import { defaultTabForProject } from "../../../lib/project-preview-tab";
import {
  fetchProjectChatSessions,
  PROJECT_CHAT_PAGE_SIZE,
  visibleProjectChatItems,
  type ProjectChatListItem,
} from "../../../lib/project-chat-sessions";
import {
  chatActivityEvents,
  chatSessionEvents,
} from "../../../lib/chat-session-events";
import { densityFor } from "../../../lib/phone-density";
import { isNativePlatform, usePhoneLayout } from "../../../lib/native-phone-layout";
import {
  SidebarContextMenu,
  type SidebarMenuEntry,
} from "../SidebarContextMenu";
import { ChatSessionList } from "./ChatSessionList";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { NativeProjectActionsSheet } from "./NativeProjectActionsSheet";

// ─── ProjectTreeItem (a project + its nested chats) ─────────

export const ProjectTreeItem = observer(function ProjectTreeItem({
  project,
  collapsed,
  onNavPress,
  isPinned,
  onTogglePin,
  mobileProjectFirstTapShowsChats,
  onMobileProjectExpand,
  mobileProjectDetail,
}: {
  project: any;
  collapsed?: boolean;
  onNavPress?: () => void;
  isPinned?: boolean;
  onTogglePin?: (projectId: string, next: boolean) => void;
  mobileProjectFirstTapShowsChats?: boolean;
  onMobileProjectExpand?: (projectId: string) => void;
  mobileProjectDetail?: boolean;
}) {
  const router = useRouter();
  // Viewport-based, not Platform-gated: narrow mobile web gets the same
  // comfortable row/text/icon density as the native app. `nativeLongPress`
  // stays Platform-gated below — the long-press project-actions sheet is a
  // genuinely native-only interaction pattern, unrelated to row density.
  const comfortable = usePhoneLayout();
  const nativeLongPress = isNativePlatform();
  const density = densityFor(comfortable);
  const workspacePane =
    Platform.OS === "web" && !comfortable && !mobileProjectDetail;
  const pathname = usePathname();
  const params = useLocalSearchParams<{ chatSessionId?: string }>();
  const http = useDomainHttp();
  const actions = useDomainActions();
  const workspaceAccess = usePermissions({ workspaceId: project.workspaceId });
  const projectPermissions = projectPermissionsFor(project, workspaceAccess);
  const canEditProject = projectPermissions.has("project:update");
  const canDeleteProject = projectPermissions.has("project:delete");
  const [expanded, setExpanded] = useState(false);
  // Chats are fetched directly into local state (rather than the shared
  // chat-session collection) because the collection's loaders prune items
  // from other contexts — expanding a second project would otherwise wipe
  // the first project's chats out of the cache.
  const [sessions, setSessions] = useState<ProjectChatListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [totalChats, setTotalChats] = useState(0);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const seededRef = useRef(false);
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
  const suppressNextProjectPressRef = useRef(false);
  // Delete confirmation for this project. Chat deletes go through the shared
  // in-app dialog inside ChatSessionList.
  const [confirmDelete, setConfirmDelete] = useState<{
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
  // The open project stays expanded, but the row itself only looks selected
  // when no chat under it is the current selection.
  const projectHighlighted = isActive && !activeChatId;

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
        setTotalChats(
          typeof result.total === "number"
            ? result.total
            : result.sessions.length,
        );
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

  // Force a re-fetch even if this project's chats were already seeded.
  const refreshChats = useCallback(() => {
    seededRef.current = false;
    setTotalChats(0);
    setHasMoreChats(false);
    setLoadingMoreChats(false);
    void loadChats();
  }, [loadChats]);

  const handleLoadMoreChats = useCallback(() => {
    if (!hasMoreChats || loadingMoreChats) return;
    void loadChats(sessions.length + PROJECT_CHAT_PAGE_SIZE);
  }, [hasMoreChats, loadingMoreChats, loadChats, sessions.length]);

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

  useEffect(() => {
    if (!mobileProjectDetail || collapsed) return;
    setExpanded(true);
    void loadChats();
  }, [collapsed, loadChats, mobileProjectDetail]);

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

  // The primary tap always opens the project directly (Canvas/Chat, landing
  // on its most-recently-used chat) — it no longer detours through an inline
  // chat-picker expansion or the `/project-chats` screen. That detour is now
  // only reachable via the explicit chevron affordance below
  // (`handleBrowseChats`), for anyone who wants to pick a specific chat
  // instead of the auto-selected most-recent one.
  const handleProjectPress = useCallback(() => {
    openProject();
  }, [openProject]);

  const handleBrowseChats = useCallback(() => {
    if (onMobileProjectExpand) {
      onMobileProjectExpand(project.id);
      return;
    }
    router.push({
      pathname: "/(app)/project-chats",
      params: { id: project.id },
    } as any);
    onNavPress?.();
  }, [onMobileProjectExpand, onNavPress, project.id, router]);

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
        chatSessionEvents.emit({ projectId: project.id, refresh: true });
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
        chatSessionEvents.emit({ projectId: project.id, refresh: true });
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
        chatSessionEvents.emit({ projectId: project.id, refresh: true });
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
        chatSessionEvents.emit({ projectId: project.id, refresh: true });
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
    if (!nativeLongPress) return;
    // React Native can deliver onPress after onLongPress on release. Without
    // suppressing that follow-up press, the normal project navigation calls
    // onNavPress and closes the drawer underneath this sheet.
    suppressNextProjectPressRef.current = true;
    setNativeActionsOpen(true);
  }, [nativeLongPress]);

  const closeNativeActions = useCallback(() => {
    suppressNextProjectPressRef.current = false;
    setNativeActionsOpen(false);
  }, []);

  const handleProjectRowPress = useCallback(() => {
    if (suppressNextProjectPressRef.current) {
      suppressNextProjectPressRef.current = false;
      return;
    }
    handleProjectPress();
  }, [handleProjectPress]);

  const requestProjectDelete = useCallback(() => {
    setConfirmDelete({
      id: project.id,
      label: project.name || "Untitled",
    });
  }, [project.id, project.name]);

  const performDelete = useCallback(async () => {
    const target = confirmDelete;
    setConfirmDelete(null);
    if (!target) return;
    try {
      await actions.deleteProject(target.id);
    } catch (e) {
      console.error("[AppSidebar] Failed to delete project:", e);
    }
  }, [confirmDelete, actions]);

  if (collapsed) {
    return "";
  }

  const projectMenuItems: SidebarMenuEntry[] = [
    ...(canEditProject
      ? [
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
        ]
      : []),
    {
      label: isPinned ? "Unpin" : "Pin",
      icon: isPinned ? (
        <PinOff size={14} className="text-muted-foreground" />
      ) : (
        <Pin size={14} className="text-muted-foreground" />
      ),
      onSelect: () => onTogglePin?.(project.id, !isPinned),
    },
    ...(canDeleteProject
      ? [
          { separator: true as const },
          {
            label: "Delete",
            danger: true,
            icon: <Trash2 size={14} className="text-destructive" />,
            onSelect: requestProjectDelete,
          },
        ]
      : []),
  ];

  const renderChatList = () => (
    <ChatSessionList
      sessions={visibleProjectChatItems(sessions)}
      archivedSessions={sessions.filter((s: any) => s.isArchived)}
      activeChatId={isActive ? activeChatId : null}
      revealActiveChat={isActive}
      streamingIds={streamingIds}
      completedIds={completedIds}
      variant={workspacePane ? "workspacePane" : undefined}
      mobileProjectDetail={mobileProjectDetail}
      loaded={loaded}
      emptyLabel="No chats yet"
      hasMore={hasMoreChats}
      loadingMore={loadingMoreChats}
      onLoadMore={handleLoadMoreChats}
      onSeeAll={handleBrowseChats}
      onSelect={handleSelectChat}
      onTogglePin={handleTogglePin}
      onRename={handleRename}
      onToggleArchive={handleToggleArchive}
      onDeleteChat={handleDeleteChat}
      totalCount={Math.max(totalChats, sessions.length)}
      scopeLabel={project.name || "Untitled"}
      listAccessibilityLabel={`${project.name || "Untitled"} chats`}
    />
  );

  return (
    <View className={mobileProjectDetail ? "flex-1" : undefined}>
      {mobileProjectDetail ? (
        <View className="flex-1">
          <View className="flex-row items-center gap-3 px-3 py-3">
            <View className="min-w-0 flex-1 flex-row items-center gap-3">
              <Folder
                size={density.icon.md}
                className="text-muted-foreground shrink-0"
              />
              <Text
                className={`${density.text.body} flex-1 font-semibold text-foreground`}
                numberOfLines={1}
              >
                {project.name || "Untitled"}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Pressable
                onPress={handleCreateChat}
                accessibilityLabel={`New chat in ${project.name || "Untitled"}`}
                className="h-10 w-10 items-center justify-center rounded-md active:bg-muted"
              >
                <Plus size={density.icon.lg} className="text-foreground" />
              </Pressable>
            </View>
          </View>
          {renderChatList()}
        </View>
      ) : editing ? (
        <View
          className={cn(
            "flex-row items-center rounded-md px-2",
            comfortable ? `${density.rowMin} gap-2 py-1.5` : "gap-1.5 py-1.5",
          )}
        >
          <Folder
            size={comfortable ? density.icon.md : 12}
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
              comfortable ? `h-11 ${density.text.body}` : "h-6 text-xs",
            )}
          />
          <Pressable
            onPress={saveEditProject}
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
      ) : (
        <View
          className={cn(
            "group flex-row items-center pr-1",
            comfortable
              ? `${density.rowMin} gap-2 rounded-md py-2`
              : "gap-1.5 rounded-lg py-1.5",
            projectHighlighted
              ? comfortable
                ? "bg-accent"
                : "bg-sidebar-accent"
              : comfortable
                ? "hover:bg-accent/50 active:bg-accent/50"
                : "hover:bg-sidebar-accent/60 active:bg-sidebar-accent/60",
          )}
        >
          <Pressable
            onPress={handleProjectRowPress}
            onLongPress={nativeLongPress ? openNativeActions : undefined}
            delayLongPress={nativeLongPress ? 400 : undefined}
            role="link"
            accessibilityLabel={`Project: ${project.name || "Untitled"}`}
            accessibilityHint={
              nativeLongPress ? "Long press for project actions" : undefined
            }
            className="flex-1 flex-row items-center gap-2 px-2 active:opacity-70 min-w-0"
            {...(Platform.OS === "web"
              ? ({ onContextMenu: handleContextMenu } as any)
              : {})}
          >
            <Folder
              size={comfortable ? density.icon.md : 12}
              className={projectHighlighted ? "text-foreground" : "text-muted-foreground"}
            />
            <Text
              className={cn(
                "flex-1",
                comfortable
                  ? density.text.body
                  : "text-xs",
                comfortable
                  ? "text-foreground"
                  : projectHighlighted
                    ? "font-semibold text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80",
              )}
              numberOfLines={1}
            >
              {project.name || "Untitled"}
            </Text>
            {project.visibility === "restricted" && (
              <Lock
                size={comfortable ? density.icon.xs : 10}
                className="text-muted-foreground"
              />
            )}
          </Pressable>
          {mobileProjectFirstTapShowsChats ? (
            // Explicit "browse chats" affordance. The row itself now always
            // opens the project directly (landing on its most-recent chat);
            // this chevron is the one remaining way to see the full chat
            // list before picking one.
            <Pressable
              onPress={handleBrowseChats}
              accessibilityLabel={`Show chats for ${project.name || "Untitled"}`}
              accessibilityHint="Opens the project's chats"
              className="h-11 w-10 items-center justify-center rounded-md active:opacity-70"
            >
              <ChevronRight
                size={comfortable ? density.icon.sm : 16}
                className="text-muted-foreground shrink-0"
              />
            </Pressable>
          ) : null}
          {/* Persistent pin glyph when pinned (comfortable phone density).
              Hidden there — the Pinned section already groups these rows,
              and hover-reveal actions do not exist on touch. */}
          {isPinned && !comfortable && (
            <View className="pr-1 shrink-0 opacity-100 group-hover:opacity-0">
              <Pin size={10} className="text-muted-foreground" />
            </View>
          )}
          {/* Hover-reveal actions (web). Siblings of the project Pressable, so
              tapping one never triggers the project-open press. */}
          {Platform.OS === "web" && (
          <View className="flex flex-row items-center gap-0.5 shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
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
      {!mobileProjectDetail && expanded && !mobileProjectFirstTapShowsChats && renderChatList()}
      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          items={projectMenuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {nativeLongPress && (
        <NativeProjectActionsSheet
          visible={nativeActionsOpen}
          projectName={project.name || "Untitled"}
          isPinned={!!isPinned}
          onClose={closeNativeActions}
          onRename={canEditProject ? startEditProject : undefined}
          onTogglePin={() => onTogglePin?.(project.id, !isPinned)}
          onDelete={canDeleteProject ? requestProjectDelete : undefined}
        />
      )}
      <ConfirmDeleteDialog
        visible={!!confirmDelete}
        title="Delete project"
        message={`Permanently delete "${confirmDelete?.label}" and all of its chats? This can't be undone.`}
        onClose={() => setConfirmDelete(null)}
        onConfirm={performDelete}
      />
    </View>
  );
});
