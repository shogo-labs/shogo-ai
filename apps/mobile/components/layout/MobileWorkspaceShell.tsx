// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phone and narrow-web chrome for Workspace Agent Chat. Desktop owns the
 * rail/context/inspector composition; this shell deliberately keeps one
 * focused transcript with a session drawer trigger and compact workspace
 * identity.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Menu,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@shogo/shared-ui/primitives";
import {
  useDomainActions,
  useDomainHttp,
  useProjectCollection,
} from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { api } from "../../lib/api";
import {
  fetchProjectChatSessions,
  projectChatLabel,
  type ProjectChatListItem,
} from "../../lib/project-chat-sessions";
import { NotificationBell } from "../notifications/NotificationBell";
import { ChatTreeItem } from "./sidebar/ChatTreeItem";
import {
  SidebarContextMenu,
  type SidebarMenuEntry,
} from "./SidebarContextMenu";
import { NativeProjectActionsSheet } from "./sidebar/NativeProjectActionsSheet";
import {
  getPinnedProjectIds,
  setPinnedProjectIds,
} from "../../lib/project-prefs-store";
import { projectSidebarEvents } from "../../lib/project-sidebar-events";
import { RenameProjectModal } from "../project/topbar/dropdown/RenameProjectModal";
import {
  NATIVE_PHONE_HEADER_ICON_SIZE,
  useNativePhoneIconChrome,
} from "../../lib/native-phone-layout";
import { WorkspaceSidebarSection } from "./WorkspaceSidebarSection";
import {
  LiquidGlassBackdrop,
  supportsLiquidGlass,
} from "../ui/LiquidGlassBackdrop";
import { MobileWorkspaceChromeProvider } from "./MobileWorkspaceChromeContext";
import { ShogoLogoMark } from "../branding/ShogoLogoMark";
import {
  MobileWorkspaceSwitcherRow,
  MobileWorkspaceSwitcherSheet,
} from "./MobileWorkspaceSwitcher";

interface MobileWorkspaceShellProps {
  children: ReactNode;
}

type ProjectChatState = {
  sessions: ProjectChatListItem[];
  loading: boolean;
};

// Drawer rows use 16px text with 6px vertical padding: six whole 36px rows.
const DRAWER_CHAT_LIST_MAX_HEIGHT = 216;
const DRAWER_OPEN_SWIPE_DISTANCE = 48;
const DRAWER_CLOSE_SWIPE_DISTANCE = 48;

export function MobileWorkspaceShell({ children }: MobileWorkspaceShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const routeParams = useLocalSearchParams<{
    chatSessionId?: string;
    navTab?: string;
    surface?: string;
    tab?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const icon = useNativePhoneIconChrome();
  const liquidGlass = supportsLiquidGlass();
  const http = useDomainHttp();
  const actions = useDomainActions();
  const workspace = useActiveWorkspace();
  const workspaceExperience = useWorkspaceExperience();
  const isTeamWorkspace = workspaceExperience.kind === "team";
  const projects = useProjectCollection();
  const prefersReducedMotion = useReducedMotion();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const drawerProgress = useRef(new Animated.Value(0)).current;
  const [sessions, setSessions] = useState<
    Array<{
      id: string;
      name?: string | null;
      inferredName?: string | null;
      isPrimary?: boolean;
      isPinned?: boolean;
      isArchived?: boolean;
    }>
  >([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sideChatsExpanded, setSideChatsExpanded] = useState(true);
  const [archivedSideChatsExpanded, setArchivedSideChatsExpanded] =
    useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [pinnedProjectIds, setPinnedProjectIdsState] = useState<Set<string>>(
    () => new Set(getPinnedProjectIds())
  );
  const [projectMenu, setProjectMenu] = useState<{
    project: any;
    x: number;
    y: number;
  } | null>(null);
  const [nativeProjectActions, setNativeProjectActions] = useState<any>(null);
  const [renamingProject, setRenamingProject] = useState<any>(null);
  const suppressNextProjectToggleRef = useRef<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [expandedArchivedProjectIds, setExpandedArchivedProjectIds] = useState<
    Set<string>
  >(() => new Set());
  const [projectChats, setProjectChats] = useState<
    Record<string, ProjectChatState>
  >({});
  const filteredSessions = sessions.filter((session) => {
    const label = session.name || session.inferredName || "Untitled side chat";
    return label.toLowerCase().includes(sessionSearch.trim().toLowerCase());
  });
  const sideChats = filteredSessions
    .filter((session) => !session.isPrimary && !session.isArchived)
    .sort((a, b) => {
      return (
        Number(!!b.isPinned) - Number(!!a.isPinned) ||
        String(b.id).localeCompare(String(a.id))
      );
    });
  const archivedSideChats = filteredSessions
    .filter((session) => !session.isPrimary && session.isArchived)
    .sort((a, b) => {
      return (
        Number(!!b.isPinned) - Number(!!a.isPinned) ||
        String(b.id).localeCompare(String(a.id))
      );
    });
  const showArchivedSideChats =
    archivedSideChatsExpanded || sessionSearch.trim().length > 0;
  const workspaceProjects = projects.all
    .filter((project: any) => project.workspaceId === workspace?.id)
    .sort((a: any, b: any) => {
      return (
        Number(pinnedProjectIds.has(b.id)) -
        Number(pinnedProjectIds.has(a.id))
      );
    });
  const activeProjectId =
    pathname.match(/\/(?:projects|project-chat)\/([^/?]+)/)?.[1] ?? null;
  const projectPane =
    routeParams.navTab ?? routeParams.surface ?? routeParams.tab;
  // Full project detail routes render their own native header. Standalone
  // project-chat routes do not, so they continue to use this shared menu/bell
  // chrome.
  const isProjectDetailRoute = /\/projects\//.test(pathname);
  const showChatChrome =
    !isProjectDetailRoute &&
    !pathname.includes("/project-surface/") &&
    !["canvas", "external-preview", "app-preview", "files", "plans"].includes(
      projectPane ?? ""
    );
  const drawerWidth = Math.min(width * 0.86, 360);
  const sessionsOpenRef = useRef(sessionsOpen);
  const showChatChromeRef = useRef(showChatChrome);
  const openSessionsRef = useRef<() => void>(() => {});
  const closeSessionsRef = useRef<() => void>(() => {});
  sessionsOpenRef.current = sessionsOpen;
  showChatChromeRef.current = showChatChrome;

  const openSessions = () => {
    setSessionsOpen(true);
    requestAnimationFrame(() => {
      Animated.timing(drawerProgress, {
        toValue: 1,
        duration: prefersReducedMotion ? 0 : 220,
        useNativeDriver: true,
      }).start();
    });
  };

  const closeSessions = () => {
    Animated.timing(drawerProgress, {
      toValue: 0,
      duration: prefersReducedMotion ? 0 : 180,
      useNativeDriver: true,
    }).start(() => setSessionsOpen(false));
  };
  const openWorkspaceSheetAfterDrawerDismissRef = useRef(false);

  const openWorkspaceSwitcher = () => {
    // Android/web can present the workspace sheet over the open drawer. Keep
    // that established interaction intact; only iOS needs to dismiss the
    // existing React Native Modal before presenting the next one. Wait for
    // the modal's native dismissal event rather than guessing with a timer.
    if (Platform.OS !== "ios") {
      setWorkspaceSheetOpen(true);
      return;
    }

    if (!sessionsOpenRef.current) {
      setWorkspaceSheetOpen(true);
      return;
    }

    openWorkspaceSheetAfterDrawerDismissRef.current = true;
    closeSessions();
  };

  useEffect(
    () => () => {
      openWorkspaceSheetAfterDrawerDismissRef.current = false;
    },
    []
  );
  openSessionsRef.current = openSessions;
  closeSessionsRef.current = closeSessions;

  // Project detail uses NativePhoneHeader, whose menu button emits this
  // existing event. The legacy app drawer intentionally ignores it while this
  // shell owns the screen, so this shell must claim it and open its drawer.
  useEffect(
    () =>
      projectSidebarEvents.subscribeOpenProject(() => {
        openSessionsRef.current();
      }),
    []
  );

  // The mobile workspace chrome owns its drawer. Claim only clear,
  // horizontal right-swipes so vertical transcript scrolling remains native.
  const sessionDrawerSwipeHandlers = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          showChatChromeRef.current &&
          !sessionsOpenRef.current &&
          gesture.dx > 8 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderRelease: (_event, gesture) => {
          if (
            gesture.dx >= DRAWER_OPEN_SWIPE_DISTANCE ||
            gesture.vx > 0.45
          ) {
            openSessionsRef.current();
          }
        },
      }).panHandlers,
    [],
  );
  const sessionDrawerCloseSwipeHandlers = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          sessionsOpenRef.current &&
          gesture.dx < -8 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderRelease: (_event, gesture) => {
          if (
            gesture.dx <= -DRAWER_CLOSE_SWIPE_DISTANCE ||
            gesture.vx < -0.45
          ) {
            closeSessionsRef.current();
          }
        },
      }).panHandlers,
    [],
  );

  useEffect(() => {
    if (showChatChrome) return;
    drawerProgress.stopAnimation();
    drawerProgress.setValue(0);
    setSessionsOpen(false);
  }, [drawerProgress, showChatChrome]);

  useEffect(() => {
    if (!sessionsOpen || !workspace?.id) return;
    let cancelled = false;
    setLoadingSessions(true);
    void api
      .listWorkspaceSessions(http, workspace.id)
      .then((next) => {
        if (!cancelled) setSessions(next);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [http, sessionsOpen, workspace?.id]);

  useEffect(() => {
    setExpandedProjectIds(new Set());
    setExpandedArchivedProjectIds(new Set());
    setProjectChats({});
  }, [workspace?.id]);

  useEffect(() => {
    if (!sessionsOpen || !workspace?.id) return;
    void projects.loadAll({ workspaceId: workspace.id }).catch(() => undefined);
  }, [projects, sessionsOpen, workspace?.id]);

  const createSideChat = async () => {
    if (!workspace?.id || creatingSession) return;
    try {
      setCreatingSession(true);
      const session = await api.createWorkspaceSession(http, workspace.id);
      setSessions((current) => [...current, session]);
      drawerProgress.setValue(0);
      setSessionsOpen(false);
      router.push({
        pathname: "/(app)/side-chats/[id]",
        params: { id: session.id },
      } as any);
    } finally {
      setCreatingSession(false);
    }
  };

  const loadProjectChats = useCallback(
    async (projectId: string) => {
      setProjectChats((current) => ({
        ...current,
        [projectId]: {
          sessions: current[projectId]?.sessions ?? [],
          loading: true,
        },
      }));
      try {
        const result = await fetchProjectChatSessions(http, projectId);
        setProjectChats((current) => ({
          ...current,
          [projectId]: {
            sessions: result.sessions,
            loading: false,
          },
        }));
      } catch {
        setProjectChats((current) => ({
          ...current,
          [projectId]: {
            sessions: current[projectId]?.sessions ?? [],
            loading: false,
          },
        }));
      }
    },
    [http]
  );

  const toggleProjectChats = useCallback(
    (projectId: string) => {
      const expanded = expandedProjectIds.has(projectId);
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return next;
      });
      if (!expanded && !projectChats[projectId]) {
        void loadProjectChats(projectId);
      }
    },
    [expandedProjectIds, loadProjectChats, projectChats]
  );

  const startProjectChat = (projectId: string) => {
    closeSessions();
    router.push({
      pathname: "/(app)/project-chat/[id]",
      params: {
        id: projectId,
        newChatNonce: String(Date.now()),
      },
    } as any);
  };

  const requestDeleteChat = (onConfirm: () => void) => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm("Delete this chat? This cannot be undone.")) onConfirm();
      return;
    }
    Alert.alert("Delete chat", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onConfirm },
    ]);
  };

  const updateWorkspaceChat = async (
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
  };

  const deleteWorkspaceChat = async (sessionId: string) => {
    const previous = sessions;
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    try {
      await http.delete(`/api/chat-sessions/${encodeURIComponent(sessionId)}`);
    } catch {
      setSessions(previous);
    }
  };

  const updateProjectChat = async (
    projectId: string,
    sessionId: string,
    changes: { name?: string; isPinned?: boolean; isArchived?: boolean }
  ) => {
    const previous = projectChats[projectId]?.sessions ?? [];
    setProjectChats((current) => {
      const state = current[projectId];
      return state
        ? {
            ...current,
            [projectId]: {
              ...state,
              sessions: state.sessions.map((session) =>
                session.id === sessionId ? { ...session, ...changes } : session
              ),
            },
          }
        : current;
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
  };

  const deleteProjectChat = async (projectId: string, sessionId: string) => {
    const previous = projectChats[projectId]?.sessions ?? [];
    setProjectChats((current) => {
      const state = current[projectId];
      return state
        ? {
            ...current,
            [projectId]: {
              ...state,
              sessions: state.sessions.filter((session) => session.id !== sessionId),
            },
          }
        : current;
    });
    try {
      await http.delete(`/api/chat-sessions/${encodeURIComponent(sessionId)}`);
    } catch {
      setProjectChats((current) => {
        const state = current[projectId];
        return state
          ? { ...current, [projectId]: { ...state, sessions: previous } }
          : current;
      });
    }
  };

  const toggleProjectPin = (projectId: string, next: boolean) => {
    setPinnedProjectIdsState((current) => {
      const updated = new Set(current);
      if (next) updated.add(projectId);
      else updated.delete(projectId);
      setPinnedProjectIds(Array.from(updated));
      return updated;
    });
  };

  const renameProject = async (projectId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await actions.updateProject(projectId, { name: trimmed });
  };

  const deleteProject = (project: any) => {
    const confirm = async () => {
      await actions.deleteProject(project.id);
      setPinnedProjectIdsState((current) => {
        const updated = new Set(current);
        updated.delete(project.id);
        setPinnedProjectIds(Array.from(updated));
        return updated;
      });
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Delete ${project.name || "this project"}? This cannot be undone.`)) {
        void confirm();
      }
      return;
    }
    Alert.alert(
      "Delete project",
      `Delete ${project.name || "this project"}? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void confirm() },
      ]
    );
  };

  const projectMenuItems: SidebarMenuEntry[] = projectMenu
    ? [
        {
          label: "Rename",
          icon: <Pencil size={14} className="text-muted-foreground" />,
          onSelect: () => setRenamingProject(projectMenu.project),
        },
        {
          label: pinnedProjectIds.has(projectMenu.project.id) ? "Unpin" : "Pin",
          icon: pinnedProjectIds.has(projectMenu.project.id) ? (
            <PinOff size={14} className="text-muted-foreground" />
          ) : (
            <Pin size={14} className="text-muted-foreground" />
          ),
          onSelect: () =>
            toggleProjectPin(
              projectMenu.project.id,
              !pinnedProjectIds.has(projectMenu.project.id)
            ),
        },
        { separator: true },
        {
          label: "Delete",
          danger: true,
          icon: <Trash2 size={14} className="text-destructive" />,
          onSelect: () => deleteProject(projectMenu.project),
        },
      ]
    : [];

  return (
    <MobileWorkspaceChromeProvider>
      <View
        className="relative flex-1 bg-background"
        {...sessionDrawerSwipeHandlers}
      >
        <View className="min-h-0 flex-1">{children}</View>
        {showChatChrome ? (
          <>
            <View
              className="absolute left-3 z-20 flex-row items-center"
              style={{ top: insets.top + 10 }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  sessionsOpen ? "Close chat sessions" : "Open chat sessions"
                }
                accessibilityState={{ expanded: sessionsOpen }}
                onPress={() =>
                  sessionsOpen ? closeSessions() : openSessions()
                }
                className={cn(
                  "h-11 w-11 items-center justify-center overflow-hidden rounded-full active:bg-muted",
                  liquidGlass ? "bg-transparent" : "bg-card/70"
                )}
              >
                <LiquidGlassBackdrop style={{ borderRadius: 999 }} />
                <Menu
                  size={20}
                  color={icon.color}
                  strokeWidth={icon.strokeWidth}
                />
              </Pressable>
            </View>
            <View
              className={cn(
                "absolute right-3 z-20 h-11 w-11 items-center justify-center overflow-hidden rounded-full",
                liquidGlass ? "bg-transparent" : "bg-card/70"
              )}
              style={{ top: insets.top + 10 }}
            >
              <LiquidGlassBackdrop style={{ borderRadius: 999 }} />
              <NotificationBell size={NATIVE_PHONE_HEADER_ICON_SIZE} />
            </View>
          </>
        ) : null}
        <Modal
          visible={sessionsOpen}
          transparent
          animationType="none"
          onRequestClose={closeSessions}
          onDismiss={() => {
            if (!openWorkspaceSheetAfterDrawerDismissRef.current) return;
            openWorkspaceSheetAfterDrawerDismissRef.current = false;
            setWorkspaceSheetOpen(true);
          }}
        >
          <View className="flex-1">
            <Animated.View
              className="absolute inset-0"
              style={{
                backgroundColor: "#000",
                opacity: drawerProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 0.4],
                }),
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close chat drawer"
              onPress={closeSessions}
              // NativeWind's `absolute inset-0` does not apply reliably to
              // this Modal backdrop Pressable.
              style={StyleSheet.absoluteFill}
            />
            <Animated.View
              accessibilityViewIsModal
              className="z-10 h-full border-r border-border/70"
              {...sessionDrawerCloseSwipeHandlers}
              style={{
                width: drawerWidth,
                height: "100%",
                transform: [
                  {
                    translateX: drawerProgress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-drawerWidth, 0],
                    }),
                  },
                ],
              }}
            >
              <View
                className="h-full bg-card"
                style={{ paddingTop: insets.top + 12 }}
              >
                <MobileWorkspaceSwitcherRow
                  onPress={openWorkspaceSwitcher}
                />
                <View className="mx-4 flex-row items-center gap-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Shogo Home"
                    onPress={() => {
                      closeSessions();
                      router.replace("/(app)" as any);
                    }}
                    className="h-11 w-11 items-center justify-center rounded-xl active:bg-muted"
                  >
                    <ShogoLogoMark className="h-6 w-6" />
                  </Pressable>
                  <View
                    className="h-12 min-w-0 flex-1 flex-row items-center gap-2 rounded-2xl border border-border/70 bg-background px-3"
                  >
                    <Search
                      size={16}
                      color={icon.color}
                      strokeWidth={icon.strokeWidth}
                    />
                    <TextInput
                      value={sessionSearch}
                      onChangeText={setSessionSearch}
                      placeholder="Search chats"
                      placeholderTextColor="#8a8a8f"
                      accessibilityLabel="Search chats"
                      className="h-full min-w-0 flex-1 py-0 text-sm text-foreground web:outline-none no-focus-ring"
                    />
                  </View>
                </View>
                <ScrollView
                  className="mt-3 flex-1"
                  contentContainerClassName="px-4 pb-8"
                  keyboardShouldPersistTaps="handled"
                >
                  {loadingSessions ? (
                    <Text className="py-3 text-sm text-muted-foreground">
                      Loading chats…
                    </Text>
                  ) : null}
                  {isTeamWorkspace ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="New project"
                      onPress={() => {
                        closeSessions();
                        router.replace("/(app)/new-project" as any);
                      }}
                      className="rounded-xl bg-primary/10 px-3 py-3 active:opacity-80"
                    >
                      <Text className="text-base font-semibold text-foreground">
                        New Project
                      </Text>
                    </Pressable>
                  ) : (
                    sessions
                      .filter((session) => session.isPrimary)
                      .map((session) => (
                        <Pressable
                          key={session.id}
                          onPress={() => {
                            closeSessions();
                            router.replace("/(app)" as any);
                          }}
                          className="rounded-xl bg-primary/10 px-3 py-3 active:opacity-80"
                        >
                          <Text className="text-base font-semibold text-foreground">
                            Main chat
                          </Text>
                        </Pressable>
                      ))
                  )}
                  <View className="mt-4">
                    <WorkspaceSidebarSection
                      label="Side chats"
                      expanded={sideChatsExpanded}
                      onExpandedChange={setSideChatsExpanded}
                      headerClassName="px-3"
                      action={
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Start a new side chat"
                          disabled={creatingSession}
                          onPress={() => void createSideChat()}
                          className="h-11 w-11 items-center justify-center rounded-lg active:bg-muted disabled:opacity-50"
                        >
                          {creatingSession ? (
                            <Text className="text-xs text-muted-foreground">
                              …
                            </Text>
                          ) : (
                            <Plus size={17} color={icon.color} />
                          )}
                        </Pressable>
                      }
                    >
                      <ScrollView
                        nestedScrollEnabled
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={sideChats.length > 6}
                        style={{ maxHeight: DRAWER_CHAT_LIST_MAX_HEIGHT }}
                      >
                        {sideChats.map((session) => (
                          <ChatTreeItem
                            key={session.id}
                            session={session}
                            onSelect={() => {
                              closeSessions();
                              router.push({
                                pathname: "/(app)/side-chats/[id]",
                                params: { id: session.id },
                              } as any);
                            }}
                            onTogglePin={(id, next) =>
                              void updateWorkspaceChat(id, { isPinned: next })
                            }
                            onRename={(id, name) =>
                              void updateWorkspaceChat(id, { name })
                            }
                            onToggleArchive={(id, next) =>
                              void updateWorkspaceChat(id, { isArchived: next })
                            }
                            onRequestDelete={(id) =>
                              requestDeleteChat(() => void deleteWorkspaceChat(id))
                            }
                            textClassName="text-base font-medium"
                            inactiveTextClassName="text-foreground"
                            rowClassName="min-h-0 rounded-xl px-3 py-1.5"
                          />
                        ))}
                        {!loadingSessions &&
                        sideChats.length === 0 &&
                        archivedSideChats.length === 0 ? (
                          <Text className="px-3 py-3 text-sm text-muted-foreground">
                            {sessionSearch.trim()
                              ? "No matching side chats."
                              : "No side chats yet."}
                          </Text>
                        ) : null}
                      </ScrollView>
                      {archivedSideChats.length > 0 ? (
                        <View className="mt-1">
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`${
                              showArchivedSideChats ? "Collapse" : "Expand"
                            } archived side chats`}
                            accessibilityState={{
                              expanded: showArchivedSideChats,
                            }}
                            onPress={() =>
                              setArchivedSideChatsExpanded((value) => !value)
                            }
                            className="flex-row items-center gap-2 rounded-lg px-3 py-2 active:bg-muted"
                          >
                            {showArchivedSideChats ? (
                              <ChevronDown
                                size={16}
                                className="text-muted-foreground"
                              />
                            ) : (
                              <ChevronRight
                                size={16}
                                className="text-muted-foreground"
                              />
                            )}
                            <Text className="text-sm font-medium text-muted-foreground">
                              Archived
                            </Text>
                          </Pressable>
                          {showArchivedSideChats ? (
                            <ScrollView
                              nestedScrollEnabled
                              keyboardShouldPersistTaps="handled"
                              showsVerticalScrollIndicator={
                                archivedSideChats.length > 6
                              }
                              style={{
                                maxHeight: DRAWER_CHAT_LIST_MAX_HEIGHT,
                              }}
                            >
                              {archivedSideChats.map((session) => (
                                <ChatTreeItem
                                  key={session.id}
                                  session={session}
                                  onSelect={() => {
                                    closeSessions();
                                    router.push({
                                      pathname: "/(app)/side-chats/[id]",
                                      params: { id: session.id },
                                    } as any);
                                  }}
                                  onTogglePin={(id, next) =>
                                    void updateWorkspaceChat(id, {
                                      isPinned: next,
                                    })
                                  }
                                  onRename={(id, name) =>
                                    void updateWorkspaceChat(id, { name })
                                  }
                                  onToggleArchive={(id, next) =>
                                    void updateWorkspaceChat(id, {
                                      isArchived: next,
                                    })
                                  }
                                  onRequestDelete={(id) =>
                                    requestDeleteChat(() =>
                                      void deleteWorkspaceChat(id)
                                    )
                                  }
                                  textClassName="text-base font-medium"
                                  inactiveTextClassName="text-foreground"
                                  rowClassName="min-h-0 rounded-xl px-3 py-1.5"
                                />
                              ))}
                            </ScrollView>
                          ) : null}
                        </View>
                      ) : null}
                    </WorkspaceSidebarSection>
                  </View>

                  {workspaceExperience.showProjectsTree ? (
                    <View className="mt-3">
                    <WorkspaceSidebarSection
                      label="Projects"
                      expanded={projectsExpanded}
                      onExpandedChange={setProjectsExpanded}
                      headerClassName="px-3"
                      action={
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Create a new project"
                          onPress={() => {
                            closeSessions();
                            router.push("/(app)/new-project" as any);
                          }}
                          className="h-11 w-11 items-center justify-center rounded-lg active:bg-muted"
                        >
                          <Plus size={17} color={icon.color} />
                        </Pressable>
                      }
                    >
                      {workspaceProjects.map((project: any, index: number) => {
                        const expanded = expandedProjectIds.has(project.id);
                        const chats = projectChats[project.id];
                        const activeChats =
                          chats?.sessions.filter((chat) => !chat.isArchived) ??
                          [];
                        const archivedChats =
                          chats?.sessions.filter((chat) => chat.isArchived) ??
                          [];
                        const archivedChatsExpanded =
                          expandedArchivedProjectIds.has(project.id);
                        const projectIsActive = activeProjectId === project.id;
                        return (
                          <View
                            key={project.id}
                            className={index > 0 ? "mt-2" : undefined}
                          >
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`${
                                expanded ? "Collapse" : "Expand"
                              } chats for ${
                                project.name || "Untitled project"
                              }`}
                              accessibilityState={{ expanded }}
                              onPress={() => {
                                if (
                                  suppressNextProjectToggleRef.current ===
                                  project.id
                                ) {
                                  suppressNextProjectToggleRef.current = null;
                                  return;
                                }
                                toggleProjectChats(project.id);
                              }}
                              onLongPress={
                                Platform.OS === "web"
                                  ? undefined
                                  : () => {
                                      // React Native can fire onPress after
                                      // onLongPress on release. Keep the
                                      // project list stable beneath its
                                      // native action sheet.
                                      suppressNextProjectToggleRef.current =
                                        project.id;
                                      setNativeProjectActions(project);
                                    }
                              }
                              {...(Platform.OS === "web"
                                ? ({
                                    onContextMenu: (event: any) => {
                                      event?.preventDefault?.();
                                      const nativeEvent =
                                        event?.nativeEvent ?? event;
                                      setProjectMenu({
                                        project,
                                        x: nativeEvent?.clientX ?? 0,
                                        y: nativeEvent?.clientY ?? 0,
                                      });
                                    },
                                  } as any)
                                : {})}
                              className="group flex-row items-center gap-2 rounded-xl px-3 py-1.5 active:bg-muted"
                            >
                              <Folder size={16} className="text-primary" />
                              <Text
                                className="flex-1 text-base font-medium text-foreground"
                                numberOfLines={1}
                              >
                                {project.name || "Untitled project"}
                              </Text>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Create a new chat in ${
                                  project.name || "this project"
                                }`}
                                onPress={(event) => {
                                  event.stopPropagation?.();
                                  startProjectChat(project.id);
                                }}
                                className="hidden h-8 w-8 items-center justify-center rounded-lg active:bg-muted group-hover:flex"
                              >
                                <Plus size={16} className="text-muted-foreground" />
                              </Pressable>
                              {projectIsActive ? (
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={`Open settings for ${
                                    project.name || "this project"
                                  }`}
                                  onPress={(event) => {
                                    event.stopPropagation?.();
                                    closeSessions();
                                    router.replace({
                                      pathname: "/(app)/project-chat/[id]",
                                      params: {
                                        id: project.id,
                                        ...(routeParams.chatSessionId
                                          ? {
                                              chatSessionId:
                                                routeParams.chatSessionId,
                                            }
                                          : {}),
                                        projectSettings: String(Date.now()),
                                      },
                                    } as any);
                                  }}
                                  className="h-8 w-8 items-center justify-center rounded-lg active:bg-muted"
                                >
                                  <Settings
                                    size={16}
                                    className="text-muted-foreground"
                                  />
                                </Pressable>
                              ) : null}
                            </Pressable>
                            {expanded ? (
                              <View className="ml-5 pl-2">
                                {chats?.loading ? (
                                  <View className="px-2 py-2">
                                    <ActivityIndicator size="small" />
                                  </View>
                                ) : (
                                  <>
                                    {activeChats.length > 0 ? (
                                      <ScrollView
                                        nestedScrollEnabled
                                        keyboardShouldPersistTaps="handled"
                                        showsVerticalScrollIndicator={
                                          activeChats.length > 6
                                        }
                                        style={{
                                          maxHeight:
                                            DRAWER_CHAT_LIST_MAX_HEIGHT,
                                        }}
                                      >
                                        {activeChats.map((chat) => (
                                          <ChatTreeItem
                                            key={chat.id}
                                            session={chat}
                                            onSelect={() => {
                                              closeSessions();
                                              router.push({
                                                pathname:
                                                  "/(app)/project-chat/[id]",
                                                params: {
                                                  id: project.id,
                                                  chatSessionId: chat.id,
                                                },
                                              } as any);
                                            }}
                                            onTogglePin={(id, next) =>
                                              void updateProjectChat(
                                                project.id,
                                                id,
                                                { isPinned: next }
                                              )
                                            }
                                            onRename={(id, name) =>
                                              void updateProjectChat(
                                                project.id,
                                                id,
                                                { name }
                                              )
                                            }
                                            onToggleArchive={(id, next) =>
                                              void updateProjectChat(
                                                project.id,
                                                id,
                                                { isArchived: next }
                                              )
                                            }
                                            onRequestDelete={(id) =>
                                              requestDeleteChat(() =>
                                                void deleteProjectChat(
                                                  project.id,
                                                  id
                                                )
                                              )
                                            }
                                            textClassName="text-base font-medium"
                                            inactiveTextClassName="text-foreground"
                                            rowClassName="min-h-0 rounded-lg px-2 py-1.5"
                                          />
                                        ))}
                                      </ScrollView>
                                    ) : null}
                                    {archivedChats.length > 0 ? (
                                      <View className="mt-1">
                                        <Pressable
                                          accessibilityRole="button"
                                          accessibilityLabel={`${
                                            archivedChatsExpanded
                                              ? "Collapse"
                                              : "Expand"
                                          } archived chats for ${
                                            project.name || "this project"
                                          }`}
                                          accessibilityState={{
                                            expanded: archivedChatsExpanded,
                                          }}
                                          onPress={() =>
                                            setExpandedArchivedProjectIds(
                                              (current) => {
                                                const next = new Set(current);
                                                if (next.has(project.id)) {
                                                  next.delete(project.id);
                                                } else {
                                                  next.add(project.id);
                                                }
                                                return next;
                                              }
                                            )
                                          }
                                          className="flex-row items-center gap-2 rounded-lg px-2 py-2 active:bg-muted"
                                        >
                                          {archivedChatsExpanded ? (
                                            <ChevronDown
                                              size={16}
                                              className="text-muted-foreground"
                                            />
                                          ) : (
                                            <ChevronRight
                                              size={16}
                                              className="text-muted-foreground"
                                            />
                                          )}
                                          <Text className="text-sm font-medium text-muted-foreground">
                                            Archived
                                          </Text>
                                        </Pressable>
                                        {archivedChatsExpanded ? (
                                          <ScrollView
                                            nestedScrollEnabled
                                            keyboardShouldPersistTaps="handled"
                                            showsVerticalScrollIndicator={
                                              archivedChats.length > 6
                                            }
                                            style={{
                                              maxHeight:
                                                DRAWER_CHAT_LIST_MAX_HEIGHT,
                                            }}
                                          >
                                            {archivedChats.map((chat) => (
                                              <ChatTreeItem
                                                key={chat.id}
                                                session={chat}
                                                onSelect={() => {
                                                  closeSessions();
                                                  router.push({
                                                    pathname:
                                                      "/(app)/project-chat/[id]",
                                                    params: {
                                                      id: project.id,
                                                      chatSessionId: chat.id,
                                                    },
                                                  } as any);
                                                }}
                                                onTogglePin={(id, next) =>
                                                  void updateProjectChat(
                                                    project.id,
                                                    id,
                                                    { isPinned: next }
                                                  )
                                                }
                                                onRename={(id, name) =>
                                                  void updateProjectChat(
                                                    project.id,
                                                    id,
                                                    { name }
                                                  )
                                                }
                                                onToggleArchive={(id, next) =>
                                                  void updateProjectChat(
                                                    project.id,
                                                    id,
                                                    { isArchived: next }
                                                  )
                                                }
                                                onRequestDelete={(id) =>
                                                  requestDeleteChat(() =>
                                                    void deleteProjectChat(
                                                      project.id,
                                                      id
                                                    )
                                                  )
                                                }
                                                textClassName="text-base font-medium"
                                                inactiveTextClassName="text-foreground"
                                                rowClassName="min-h-0 rounded-lg px-2 py-1.5"
                                              />
                                            ))}
                                          </ScrollView>
                                        ) : null}
                                      </View>
                                    ) : null}
                                    {activeChats.length === 0 &&
                                    archivedChats.length === 0 ? (
                                      <Text className="px-2 py-2 text-xs text-muted-foreground">
                                        No project chats yet.
                                      </Text>
                                    ) : null}
                                  </>
                                )}
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                      {workspaceProjects.length === 0 ? (
                        <Text className="px-3 py-3 text-sm text-muted-foreground">
                          No projects yet.
                        </Text>
                      ) : null}
                    </WorkspaceSidebarSection>
                    </View>
                  ) : null}
                </ScrollView>
              </View>
            </Animated.View>
          </View>
        </Modal>
        {projectMenu ? (
          <SidebarContextMenu
            x={projectMenu.x}
            y={projectMenu.y}
            items={projectMenuItems}
            onClose={() => setProjectMenu(null)}
          />
        ) : null}
        <NativeProjectActionsSheet
          visible={nativeProjectActions !== null}
          projectName={nativeProjectActions?.name || "Untitled project"}
          isPinned={
            nativeProjectActions
              ? pinnedProjectIds.has(nativeProjectActions.id)
              : false
          }
          onClose={() => {
            suppressNextProjectToggleRef.current = null;
            setNativeProjectActions(null);
          }}
          onRename={() => {
            setRenamingProject(nativeProjectActions);
            setNativeProjectActions(null);
          }}
          onTogglePin={() => {
            if (!nativeProjectActions) return;
            toggleProjectPin(
              nativeProjectActions.id,
              !pinnedProjectIds.has(nativeProjectActions.id)
            );
          }}
          onDelete={() => {
            if (nativeProjectActions) deleteProject(nativeProjectActions);
          }}
        />
        <MobileWorkspaceSwitcherSheet
          visible={workspaceSheetOpen}
          onClose={() => setWorkspaceSheetOpen(false)}
          onSwitched={closeSessions}
        />
        <RenameProjectModal
          visible={renamingProject !== null}
          currentName={renamingProject?.name || ""}
          onClose={() => setRenamingProject(null)}
          onRename={(name) => {
            if (renamingProject) void renameProject(renamingProject.id, name);
            setRenamingProject(null);
          }}
        />
      </View>
    </MobileWorkspaceChromeProvider>
  );
}
