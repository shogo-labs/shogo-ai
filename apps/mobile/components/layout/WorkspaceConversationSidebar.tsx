// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Conversation-first companion sidebar for the desktop Workspace Agent shell.
 *
 * Workspace side chats are deliberately distinct from project chats: they use
 * the merged-root Workspace Agent, while each project chat opens that project's
 * own agent/runtime.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Folder, Plus, Search } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useDomainHttp, useProjectCollection } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { api } from "../../lib/api";
import {
  fetchProjectChatSessions,
  PROJECT_CHAT_PAGE_SIZE,
  projectChatLabel,
  visibleProjectChatItems,
  type ProjectChatListItem,
} from "../../lib/project-chat-sessions";
import {
  getKnownPrimaryWorkspaceSession,
  subscribePrimaryWorkspaceSession,
} from "../workspace/workspace-agent-session-bus";
import { WorkspaceSidebarSection } from "./WorkspaceSidebarSection";
import { ChatTreeItem } from "./sidebar/ChatTreeItem";

const PROJECT_CHAT_INITIAL_COUNT = PROJECT_CHAT_PAGE_SIZE;

type WorkspaceSession = {
  id: string;
  workspaceId: string;
  isPrimary?: boolean;
  name?: string | null;
  inferredName?: string | null;
  lastActiveAt?: string;
  isPinned?: boolean;
  isArchived?: boolean;
};

type ProjectChatState = {
  sessions: ProjectChatListItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
};

function sidebarSessionLabel(session: WorkspaceSession) {
  return session.name || session.inferredName || "New side chat";
}

function routeIsActive(pathname: string, href: string): boolean {
  if (href === "/(app)")
    return (
      pathname === "/" || pathname === "/(app)" || pathname === "/(app)/index"
    );
  const normalized = href.replace("/(app)", "");
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export function WorkspaceConversationSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const http = useDomainHttp();
  const workspace = useActiveWorkspace();
  const projects = useProjectCollection();
  const experience = useWorkspaceExperience();
  const sideChatMatch = pathname.match(/\/side-chats\/([^/]+)/);
  const sideChatId = sideChatMatch?.[1]
    ? decodeURIComponent(sideChatMatch[1])
    : null;
  const projectRouteMatch = pathname.match(/\/projects\/([^/?]+)/);
  const activeProjectId = projectRouteMatch?.[1]
    ? decodeURIComponent(projectRouteMatch[1])
    : null;

  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [primarySessionId, setPrimarySessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [creatingSideChat, setCreatingSideChat] = useState(false);
  const [chatQuery, setChatQuery] = useState("");
  const [sideChatsExpanded, setSideChatsExpanded] = useState(true);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [showAllSideChats, setShowAllSideChats] = useState(false);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [projectChats, setProjectChats] = useState<
    Record<string, ProjectChatState>
  >({});

  const loadWorkspaceSessions = useCallback(
    async (publishedPrimaryId?: string | null) => {
      if (!workspace?.id) return;
      setSessionsLoading(true);
      try {
        const nextSessions = await api.listWorkspaceSessions(
          http,
          workspace.id
        );
        setSessions(nextSessions);
        setPrimarySessionId(
          publishedPrimaryId ??
            nextSessions.find((session) => session.isPrimary)?.id ??
            null
        );
      } finally {
        setSessionsLoading(false);
      }
    },
    [http, workspace?.id]
  );

  const loadWorkspaceProjects = useCallback(async () => {
    if (!workspace?.id) return;
    setProjectsLoading(true);
    try {
      await projects.loadAll({ workspaceId: workspace.id });
    } finally {
      setProjectsLoading(false);
    }
  }, [projects, workspace?.id]);

  useEffect(() => {
    if (!workspace?.id) {
      setSessions([]);
      setPrimarySessionId(null);
      setProjectChats({});
      setExpandedProjectIds(new Set());
      return;
    }

    setProjectChats({});
    setExpandedProjectIds(new Set());
    void loadWorkspaceSessions(
      getKnownPrimaryWorkspaceSession(workspace.id)
    ).catch(() => {
      setSessions([]);
      setPrimarySessionId(null);
    });
    void loadWorkspaceProjects().catch(() => undefined);

    return subscribePrimaryWorkspaceSession(workspace.id, (sessionId) => {
      void loadWorkspaceSessions(sessionId).catch(() => undefined);
    });
  }, [loadWorkspaceProjects, loadWorkspaceSessions, workspace?.id]);

  const sideChats = useMemo(
    () =>
      sessions
        .filter((session) => !session.isPrimary && !session.isArchived)
        .sort(
          (a, b) =>
            Number(!!b.isPinned) - Number(!!a.isPinned) ||
            new Date(b.lastActiveAt || 0).getTime() -
              new Date(a.lastActiveAt || 0).getTime()
        ),
    [sessions]
  );
  const normalizedChatQuery = chatQuery.trim().toLowerCase();
  const matchingSideChats = useMemo(
    () =>
      sideChats.filter(
        (session) =>
          !normalizedChatQuery ||
          sidebarSessionLabel(session)
            .toLowerCase()
            .includes(normalizedChatQuery)
      ),
    [normalizedChatQuery, sideChats]
  );
  const visibleSideChats = useMemo(() => {
    if (showAllSideChats || normalizedChatQuery) return matchingSideChats;
    const recent = matchingSideChats.slice(0, 5);
    const selected = matchingSideChats.find(
      (session) => session.id === sideChatId
    );
    return selected && !recent.some((session) => session.id === selected.id)
      ? [...recent, selected]
      : recent;
  }, [matchingSideChats, normalizedChatQuery, showAllSideChats, sideChatId]);
  const workspaceProjects = useMemo(
    () =>
      projects.all
        .filter((project: any) => project.workspaceId === workspace?.id)
        .sort((a: any, b: any) =>
          String(a.name || "").localeCompare(String(b.name || ""))
        ),
    [projects.all, workspace?.id]
  );

  const startSideChat = async () => {
    if (!workspace?.id || creatingSideChat) return;
    try {
      setCreatingSideChat(true);
      // Side chats always talk to the Workspace/Shogo agent. Project agent
      // sessions are created only from a project's own chat history below.
      const session = await api.createWorkspaceSession(http, workspace.id);
      await loadWorkspaceSessions();
      router.push({
        pathname: "/(app)/side-chats/[id]",
        params: { id: session.id },
      } as any);
    } finally {
      setCreatingSideChat(false);
    }
  };

  const loadProjectChats = useCallback(
    async (projectId: string, offset = 0) => {
      const isFirstPage = offset === 0;
      setProjectChats((current) => ({
        ...current,
        [projectId]: {
          sessions: current[projectId]?.sessions ?? [],
          loading: isFirstPage,
          loadingMore: !isFirstPage,
          hasMore: current[projectId]?.hasMore ?? false,
        },
      }));
      try {
        const result = await fetchProjectChatSessions(
          http,
          projectId,
          PROJECT_CHAT_INITIAL_COUNT,
          offset
        );
        setProjectChats((current) => ({
          ...current,
          [projectId]: {
            sessions: visibleProjectChatItems(
              isFirstPage
                ? result.sessions
                : [...(current[projectId]?.sessions ?? []), ...result.sessions]
            ),
            loading: false,
            loadingMore: false,
            hasMore: result.hasMore,
          },
        }));
      } catch {
        setProjectChats((current) => ({
          ...current,
          [projectId]: {
            sessions: current[projectId]?.sessions ?? [],
            loading: false,
            loadingMore: false,
            hasMore: false,
          },
        }));
      }
    },
    [http]
  );

  useEffect(() => {
    if (!normalizedChatQuery) return;
    workspaceProjects.forEach((project: any) => {
      if (!projectChats[project.id]) {
        void loadProjectChats(project.id);
      }
    });
  }, [loadProjectChats, normalizedChatQuery, projectChats, workspaceProjects]);

  const toggleProject = (projectId: string) => {
    const isExpanded = expandedProjectIds.has(projectId);
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    if (!isExpanded && !projectChats[projectId]) {
      void loadProjectChats(projectId);
    }
  };

  const startProjectChat = useCallback(
    (projectId: string) => {
      router.push({
        pathname: "/(app)/project-chat/[id]",
        params: {
          id: projectId,
          newChatNonce: String(Date.now()),
        },
      } as any);
    },
    [router]
  );

  const updateWorkspaceChat = useCallback(
    async (
      sessionId: string,
      changes: { name?: string; isPinned?: boolean; isArchived?: boolean }
    ) => {
      const previous = sessions;
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, ...changes } : session
        )
      );
      try {
        await http.patch(
          `/api/chat-sessions/${encodeURIComponent(sessionId)}`,
          changes
        );
      } catch {
        setSessions(previous);
      }
    },
    [http, sessions]
  );

  const updateProjectChat = useCallback(
    async (
      projectId: string,
      sessionId: string,
      changes: { name?: string; isPinned?: boolean; isArchived?: boolean }
    ) => {
      const previous = projectChats[projectId]?.sessions ?? [];
      setProjectChats((current) => {
        const state = current[projectId];
        if (!state) return current;
        return {
          ...current,
          [projectId]: {
            ...state,
            sessions: state.sessions.map((session) =>
              session.id === sessionId ? { ...session, ...changes } : session
            ),
          },
        };
      });
      try {
        await http.patch(
          `/api/chat-sessions/${encodeURIComponent(sessionId)}`,
          changes
        );
      } catch {
        setProjectChats((current) => {
          const state = current[projectId];
          return state
            ? { ...current, [projectId]: { ...state, sessions: previous } }
            : current;
        });
      }
    },
    [http, projectChats]
  );

  const requestDelete = useCallback((onConfirm: () => void) => {
    const confirm = () => {
      if (Platform.OS === "web" && typeof window !== "undefined") {
        if (window.confirm("Delete this chat? This cannot be undone."))
          onConfirm();
        return;
      }
      Alert.alert("Delete chat", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: onConfirm },
      ]);
    };
    confirm();
  }, []);

  const deleteWorkspaceChat = useCallback(
    async (sessionId: string) => {
      const previous = sessions;
      setSessions((current) =>
        current.filter((session) => session.id !== sessionId)
      );
      try {
        await http.delete(
          `/api/chat-sessions/${encodeURIComponent(sessionId)}`
        );
      } catch {
        setSessions(previous);
      }
    },
    [http, sessions]
  );

  const deleteProjectChat = useCallback(
    async (projectId: string, sessionId: string) => {
      const previous = projectChats[projectId]?.sessions ?? [];
      setProjectChats((current) => {
        const state = current[projectId];
        return state
          ? {
              ...current,
              [projectId]: {
                ...state,
                sessions: state.sessions.filter(
                  (session) => session.id !== sessionId
                ),
              },
            }
          : current;
      });
      try {
        await http.delete(
          `/api/chat-sessions/${encodeURIComponent(sessionId)}`
        );
      } catch {
        setProjectChats((current) => {
          const state = current[projectId];
          return state
            ? { ...current, [projectId]: { ...state, sessions: previous } }
            : current;
        });
      }
    },
    [http, projectChats]
  );

  const handleSideChatsExpandedChange = useCallback(
    (expanded: boolean) => {
      setSideChatsExpanded(expanded);
      if (expanded) void loadWorkspaceSessions().catch(() => undefined);
    },
    [loadWorkspaceSessions]
  );

  const handleProjectsExpandedChange = useCallback(
    (expanded: boolean) => {
      setProjectsExpanded(expanded);
      if (expanded) void loadWorkspaceProjects().catch(() => undefined);
    },
    [loadWorkspaceProjects]
  );

  return (
    <View className="w-64 shrink-0 border-r border-border/70 bg-card/60">
      <View className="px-3 py-3">
        <View className="flex-row items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 py-2">
          <Search size={16} className="text-muted-foreground" />
          <TextInput
            value={chatQuery}
            onChangeText={setChatQuery}
            placeholder="Search chats"
            placeholderTextColor="#8a8a8a"
            className="min-w-0 flex-1 text-sm leading-5 text-foreground"
            accessibilityLabel="Search side chats and project chats"
          />
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-3 py-2"
        showsVerticalScrollIndicator
      >
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open Main Chat"
          accessibilityState={{ selected: routeIsActive(pathname, "/(app)") }}
          onPress={() => router.push("/(app)" as any)}
          className={cn(
            "rounded-xl px-3 py-2",
            routeIsActive(pathname, "/(app)")
              ? "bg-primary/10"
              : "active:bg-muted"
          )}
        >
          <Text className="text-sm font-medium leading-5 text-foreground">
            Main Chat
          </Text>
        </Pressable>

        {experience.workspaceAgent.sideChats ? (
          <View className="mt-2">
            <WorkspaceSidebarSection
              label="Side chats"
              count={sessionsLoading ? undefined : matchingSideChats.length}
              expanded={sideChatsExpanded}
              onExpandedChange={handleSideChatsExpandedChange}
              collapseOnHover
              action={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Start a new Shogo side chat"
                  disabled={creatingSideChat}
                  onPress={() => void startSideChat()}
                  className="h-11 w-11 items-center justify-center rounded-lg active:bg-muted disabled:opacity-50"
                >
                  {creatingSideChat ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Plus size={17} className="text-foreground" />
                  )}
                </Pressable>
              }
            >
              {visibleSideChats.map((session) => {
                const active = session.id === sideChatId;
                return (
                  <ChatTreeItem
                    key={session.id}
                    session={session}
                    active={active}
                    textClassName="text-sm leading-5"
                    inactiveTextClassName="text-foreground"
                    rowClassName="px-2 py-2"
                    onSelect={() =>
                      router.push({
                        pathname: "/(app)/side-chats/[id]",
                        params: { id: session.id },
                      } as any)
                    }
                    onTogglePin={(id, isPinned) =>
                      void updateWorkspaceChat(id, { isPinned })
                    }
                    onRename={(id, name) =>
                      void updateWorkspaceChat(id, { name })
                    }
                    onToggleArchive={(id, isArchived) =>
                      void updateWorkspaceChat(id, { isArchived })
                    }
                    onRequestDelete={(id) =>
                      requestDelete(() => void deleteWorkspaceChat(id))
                    }
                  />
                );
              })}
              {matchingSideChats.length > 5 && !normalizedChatQuery ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    showAllSideChats
                      ? "Show fewer side chats"
                      : "Show all side chats"
                  }
                  onPress={() => setShowAllSideChats((showAll) => !showAll)}
                  className="mt-0.5 self-start rounded-md px-2 py-1 active:bg-muted"
                >
                  <Text className="text-xs font-medium text-primary">
                    {showAllSideChats ? "Show less" : "Show more"}
                  </Text>
                </Pressable>
              ) : null}
              {!sessionsLoading && matchingSideChats.length === 0 ? (
                <Text className="px-2 py-2 text-xs text-muted-foreground">
                  {normalizedChatQuery
                    ? "No matching side chats."
                    : "No side chats yet."}
                </Text>
              ) : null}
            </WorkspaceSidebarSection>
          </View>
        ) : null}

        <View className="mt-2">
          <WorkspaceSidebarSection
            label="Projects"
            count={projectsLoading ? undefined : workspaceProjects.length}
            expanded={projectsExpanded}
            onExpandedChange={handleProjectsExpandedChange}
            actionVisibility="hover"
            collapseOnHover
            action={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create a new project"
                onPress={() =>
                  router.push({
                    pathname: "/(app)/new-project",
                    params: primarySessionId
                      ? { chatSessionId: primarySessionId }
                      : {},
                  } as any)
                }
                className="h-11 w-11 items-center justify-center rounded-lg active:bg-muted"
              >
                <Plus size={17} className="text-foreground" />
              </Pressable>
            }
          >
            {workspaceProjects.map((project: any) => {
              const chats = projectChats[project.id];
              const matchingProjectChats =
                chats?.sessions.filter(
                  (chat) =>
                    !normalizedChatQuery ||
                    projectChatLabel(chat)
                      .toLowerCase()
                      .includes(normalizedChatQuery)
                ) ?? [];
              const projectNameMatches = String(project.name || "")
                .toLowerCase()
                .includes(normalizedChatQuery);
              const projectMatches =
                !normalizedChatQuery ||
                projectNameMatches ||
                matchingProjectChats.length > 0 ||
                chats?.loading;
              if (!projectMatches) return null;
              const expanded =
                expandedProjectIds.has(project.id) ||
                (!!normalizedChatQuery && !!chats);
              const visibleChats = normalizedChatQuery
                ? matchingProjectChats
                : chats?.sessions;
              const activeProject = project.id === activeProjectId;
              return (
                <View key={project.id} className="mb-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${
                      expanded ? "Collapse" : "Expand"
                    } chats for ${project.name || "Untitled project"}`}
                    accessibilityState={{ expanded }}
                    onPress={() => toggleProject(project.id)}
                    className={cn(
                      "group flex-row items-center rounded-lg hover:bg-muted",
                      activeProject && "bg-primary/10"
                    )}
                  >
                    <View className="min-w-0 flex-1 flex-row items-center gap-2 px-2.5 py-2">
                      <Folder size={16} className="text-primary" />
                      <Text
                        className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground"
                        numberOfLines={1}
                      >
                        {project.name || "Untitled project"}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Create a new chat in ${
                        project.name || "this project"
                      }`}
                      onPress={(event) => {
                        event.stopPropagation?.();
                        startProjectChat(project.id);
                      }}
                      className="mr-1 hidden h-9 w-9 items-center justify-center rounded-lg active:bg-muted group-hover:flex"
                    >
                      <Plus size={16} className="text-muted-foreground" />
                    </Pressable>
                  </Pressable>
                  {expanded ? (
                    <View className="ml-5 pl-2">
                      {chats?.loading ? (
                        <View className="items-start px-2 py-2">
                          <ActivityIndicator size="small" />
                        </View>
                      ) : visibleChats?.length ? (
                        <ScrollView
                          nestedScrollEnabled
                          showsVerticalScrollIndicator={visibleChats.length > 5}
                          style={{ maxHeight: 154 }}
                          scrollEventThrottle={16}
                          onScroll={({ nativeEvent }) => {
                            const reachedEnd =
                              nativeEvent.contentOffset.y +
                                nativeEvent.layoutMeasurement.height >=
                              nativeEvent.contentSize.height - 24;
                            if (
                              reachedEnd &&
                              chats.hasMore &&
                              !chats.loadingMore
                            ) {
                              void loadProjectChats(
                                project.id,
                                chats.sessions.length
                              );
                            }
                          }}
                        >
                          {visibleChats.map((chat) => (
                            <ChatTreeItem
                              key={chat.id}
                              session={chat}
                              textClassName="text-sm leading-5"
                              inactiveTextClassName="text-foreground"
                              rowClassName="px-2 py-2"
                              onSelect={() =>
                                router.push({
                                  pathname: "/(app)/project-chat/[id]",
                                  params: {
                                    id: project.id,
                                    chatSessionId: chat.id,
                                  },
                                } as any)
                              }
                              onTogglePin={(id, isPinned) =>
                                void updateProjectChat(project.id, id, {
                                  isPinned,
                                })
                              }
                              onRename={(id, name) =>
                                void updateProjectChat(project.id, id, { name })
                              }
                              onToggleArchive={(id, isArchived) =>
                                void updateProjectChat(project.id, id, {
                                  isArchived,
                                })
                              }
                              onRequestDelete={(id) =>
                                requestDelete(
                                  () => void deleteProjectChat(project.id, id)
                                )
                              }
                            />
                          ))}
                          {chats.loadingMore ? (
                            <View className="items-center py-2">
                              <ActivityIndicator size="small" />
                            </View>
                          ) : null}
                        </ScrollView>
                      ) : (
                        <Text className="px-2 py-2 text-xs text-muted-foreground">
                          {normalizedChatQuery
                            ? "No matching chats."
                            : "No project chats yet."}
                        </Text>
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}
            {!projectsLoading && workspaceProjects.length === 0 ? (
              <Text className="px-2 py-2 text-xs text-muted-foreground">
                No projects yet.
              </Text>
            ) : null}
            {normalizedChatQuery &&
            workspaceProjects.length > 0 &&
            !workspaceProjects.some(
              (project: any) =>
                String(project.name || "")
                  .toLowerCase()
                  .includes(normalizedChatQuery) ||
                projectChats[project.id]?.sessions.some((chat) =>
                  projectChatLabel(chat)
                    .toLowerCase()
                    .includes(normalizedChatQuery)
                ) ||
                projectChats[project.id]?.loading
            ) ? (
              <Text className="px-2 py-2 text-xs text-muted-foreground">
                No matching project chats.
              </Text>
            ) : null}
          </WorkspaceSidebarSection>
        </View>
      </ScrollView>
    </View>
  );
}
