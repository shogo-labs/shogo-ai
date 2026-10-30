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
  type GestureResponderEvent,
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
  ArrowLeft,
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
import {
  useChatSessionCollection,
  useDomainActions,
  useDomainHttp,
  useProjectCollection,
} from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { NativeCircleButton } from "../project/topbar/native/NativeCircleButton";
import {
  projectPermissionsFor,
  usePermissions,
} from "../../hooks/usePermissions";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import {
  drawerProgressFromDelta,
  drawerReleaseVelocity,
  drawerSettleTarget,
  shouldCaptureCloseSwipe,
  shouldCaptureOpenSwipe,
} from "../../lib/drawer-drag";
import { PROGRESS_REST, SPRING } from "../../lib/motion";
import { haptics } from "../../lib/haptics";
import { PressableScale } from "@shogo/shared-ui/primitives";
import {
  fetchProjectChatSessions,
  projectChatLabel,
  type ProjectChatListItem,
} from "../../lib/project-chat-sessions";
import { useWorkspaceChats } from "../../hooks/useWorkspaceChats";
import { NotificationBell } from "../notifications/NotificationBell";
import { ChatSessionList } from "./sidebar/ChatSessionList";
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
import { chatSessionEvents } from "../../lib/chat-session-events";
import { RenameProjectModal } from "../project/topbar/dropdown/RenameProjectModal";
import {
  NATIVE_PHONE_HEADER_ICON_SIZE,
  useNativePhoneIconChrome,
} from "../../lib/native-phone-layout";
import { WorkspaceSidebarSection } from "./WorkspaceSidebarSection";
import { LiquidGlassBackdrop } from "../ui/LiquidGlassBackdrop";
import { MobileWorkspaceChromeProvider } from "./MobileWorkspaceChromeContext";
import { ShogoLogoMark } from "../branding/ShogoLogoMark";
import {
  MobileWorkspaceSwitcherRow,
  MobileWorkspaceSwitcherSheet,
} from "./MobileWorkspaceSwitcher";

interface MobileWorkspaceShellProps {
  children: ReactNode;
  /**
   * When false the shell stays mounted but draws no chrome (menu button,
   * session drawer, swipe gesture). Keeping it mounted keeps `children` at the
   * same place in the React tree, so navigating between routes that do and do
   * not want the chrome does not remount the navigator (which cancels the
   * in-flight navigation and makes taps look like no-ops).
   */
  enabled?: boolean;
}

type ProjectChatState = {
  sessions: ProjectChatListItem[];
  loading: boolean;
};

// Drawer rows use 16px text with 6px vertical padding: six whole 36px rows.
const DRAWER_CHAT_LIST_MAX_HEIGHT = 216;

export function MobileWorkspaceShell({ children, enabled = true }: MobileWorkspaceShellProps) {
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
  const http = useDomainHttp();
  const actions = useDomainActions();
  const chatSessions = useChatSessionCollection();
  const workspace = useActiveWorkspace();
  const workspaceAccess = usePermissions({ workspaceId: workspace?.id });
  const canProject = (project: any, permission: "project:update" | "project:delete") =>
    !!project && projectPermissionsFor(project, workspaceAccess).has(permission);
  const workspaceExperience = useWorkspaceExperience();
  const isTeamWorkspace = workspaceExperience.kind === "team";
  const projects = useProjectCollection();
  const prefersReducedMotion = useReducedMotion();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [workspaceSheetOpen, setWorkspaceSheetOpen] = useState(false);
  const drawerProgress = useRef(new Animated.Value(0)).current;
  const workspaceChats = useWorkspaceChats(workspace?.id);
  const [sessionSearch, setSessionSearch] = useState("");
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
  const matchesSearch = (session: { name?: string | null; inferredName?: string | null }) => {
    const label = session.name || session.inferredName || "Untitled side chat";
    return label.toLowerCase().includes(sessionSearch.trim().toLowerCase());
  };
  const sideChats = workspaceChats.active.filter(matchesSearch);
  const archivedSideChats = workspaceChats.archived.filter(matchesSearch);
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
    enabled &&
    !isProjectDetailRoute &&
    !pathname.includes("/project-surface/") &&
    !["canvas", "external-preview", "app-preview", "files", "plans"].includes(
      projectPane ?? ""
    );
  // A project's chat reached from its own tab bar has no project header, so it
  // carries Back and the project name here: swiping open the drawer to leave
  // the project was the only way out.
  const isProjectChatRoute = showChatChrome && /\/project-chat\//.test(pathname);
  const projectChatName = isProjectChatRoute
    ? projects.all.find((project: any) => project.id === activeProjectId)?.name
    : undefined;
  const leaveProject = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(app)/home" as any);
  }, [router]);
  const drawerWidth = Math.min(width * 0.86, 360);
  const sessionsOpenRef = useRef(sessionsOpen);
  const showChatChromeRef = useRef(showChatChrome);
  const openSessionsRef = useRef<() => void>(() => {});
  sessionsOpenRef.current = sessionsOpen;
  showChatChromeRef.current = showChatChrome;

  // Springs, not timed eases: a new spring starts from the live value and
  // inherits the finger's release velocity, so tapping mid-animation or
  // flicking never stalls or jumps. `onDone` only fires if the spring ran to
  // the end, so an interrupted close can't unmount a drawer that is reopening.
  // `settledAtRef` is where the drawer last came to rest and `animatingRef`
  // says whether a spring is in flight, so a new drag can start from a known
  // position without waiting on an async read of the native value.
  const settledAtRef = useRef<0 | 1>(0);
  const animatingRef = useRef(false);
  const settleIdRef = useRef(0);
  const settleDrawer = (toValue: 0 | 1, velocity = 0, onDone?: () => void) => {
    const id = ++settleIdRef.current;
    if (prefersReducedMotion) {
      drawerProgress.stopAnimation();
      drawerProgress.setValue(toValue);
      animatingRef.current = false;
      settledAtRef.current = toValue;
      onDone?.();
      return;
    }
    animatingRef.current = true;
    Animated.spring(drawerProgress, {
      toValue,
      velocity,
      ...SPRING.drawer,
      ...PROGRESS_REST,
      // The panel is anchored to the screen edge; overshoot would expose a gap.
      overshootClamping: true,
      useNativeDriver: true,
    }).start(({ finished }) => {
      // A newer spring owns the value now; leave its bookkeeping alone.
      if (id !== settleIdRef.current) return;
      animatingRef.current = false;
      if (!finished) return;
      settledAtRef.current = toValue;
      onDone?.();
    });
  };
  const settleDrawerRef = useRef(settleDrawer);
  settleDrawerRef.current = settleDrawer;
  const drawerWidthRef = useRef(drawerWidth);
  drawerWidthRef.current = drawerWidth;

  const openSessions = () => {
    setSessionsOpen(true);
    requestAnimationFrame(() => settleDrawer(1));
  };

  const closeSessions = () => settleDrawer(0, 0, () => setSessionsOpen(false));
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

  // Project detail uses NativePhoneHeader, whose menu button emits this
  // existing event. The legacy app drawer intentionally ignores it while this
  // shell owns the screen, so this shell must claim it and open its drawer.
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = projectSidebarEvents.subscribeOpenProject(() => {
      openSessionsRef.current();
    });
    return () => {
      unsubscribe();
    };
  }, [enabled]);

  // The mobile workspace chrome owns its drawer. Claim only clear,
  // horizontal right-swipes so vertical transcript scrolling remains native.
  //
  // While the finger is down the panel and scrim follow it 1:1 (one progress
  // value drives both). On release a spring carries the finger's velocity to
  // whichever end it would coast to, so a flick and a slow drag both feel
  // continuous. `dragStartRef` is the progress when the finger went down, so
  // grabbing a drawer mid-animation resumes from where it actually was.
  const dragStartRef = useRef<number | null>(null);
  const beginDrawerDrag = () => {
    if (!animatingRef.current) {
      // At rest: the start is known now, so the very first move tracks.
      dragStartRef.current = settledAtRef.current;
      return;
    }
    // Grabbed mid-flight: freeze the spring and resume from where it was.
    // Moves that arrive before the read returns are replayed by the next one
    // (`dx` is cumulative), so nothing is lost.
    dragStartRef.current = null;
    settleIdRef.current += 1;
    animatingRef.current = false;
    drawerProgress.stopAnimation((value) => {
      dragStartRef.current = value;
    });
  };
  const moveDrawerDrag = (dx: number) => {
    const start = dragStartRef.current;
    if (start === null) return;
    drawerProgress.setValue(
      drawerProgressFromDelta(start, dx, drawerWidthRef.current),
    );
  };
  const endDrawerDrag = (dx: number, vx: number) => {
    const width = drawerWidthRef.current;
    const progress = drawerProgressFromDelta(dragStartRef.current ?? 0, dx, width);
    const velocity = drawerReleaseVelocity(vx, width);
    dragStartRef.current = null;
    if (drawerSettleTarget(progress, vx, width) === 1) {
      settleDrawerRef.current(1, velocity);
    } else {
      settleDrawerRef.current(0, velocity, () => setSessionsOpen(false));
    }
  };
  const sessionDrawerSwipeHandlers = useMemo(
    () =>
      PanResponder.create({
        // Capture phase: a child that already took the touch (a Pressable, a
        // message bubble) would otherwise never be asked to give it up.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          showChatChromeRef.current &&
          !sessionsOpenRef.current &&
          shouldCaptureOpenSwipe(gesture.dx, gesture.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          // Mount the drawer at progress 0 (panel off-screen, scrim clear) so
          // it exists to be dragged.
          setSessionsOpen(true);
          dragEventsRef.current.begin();
        },
        onPanResponderMove: (_event, gesture) =>
          dragEventsRef.current.move(gesture.dx),
        onPanResponderRelease: (_event, gesture) =>
          dragEventsRef.current.end(gesture.dx, gesture.vx),
        onPanResponderTerminate: (_event, gesture) =>
          dragEventsRef.current.end(gesture.dx, gesture.vx),
      }).panHandlers,
    [],
  );
  // The close drag is tracked from raw touch events instead of a
  // PanResponder: inside the drawer's Modal the responder negotiation never
  // offered the touch to a handler on the panel or its container (a child or
  // the backdrop already held it), but raw touch events always arrive. A
  // horizontal left drag past the slop starts following the finger; anything
  // else (a tap, a vertical list scroll) is left to the children.
  const closeTouchRef = useRef<{
    x0: number;
    y0: number;
    active: boolean;
    samples: { x: number; t: number }[];
  } | null>(null);
  const suppressBackdropPressUntilRef = useRef(0);
  const sessionDrawerCloseTouchHandlers = {
    onTouchStart: (event: GestureResponderEvent) => {
      const { pageX, pageY, timestamp, touches } = event.nativeEvent;
      closeTouchRef.current =
        touches.length === 1
          ? { x0: pageX, y0: pageY, active: false, samples: [{ x: pageX, t: timestamp }] }
          : null;
    },
    onTouchMove: (event: GestureResponderEvent) => {
      const touch = closeTouchRef.current;
      if (!touch || !sessionsOpenRef.current) return;
      const { pageX, pageY, timestamp } = event.nativeEvent;
      const dx = pageX - touch.x0;
      const dy = pageY - touch.y0;
      touch.samples.push({ x: pageX, t: timestamp });
      if (touch.samples.length > 6) touch.samples.shift();
      if (!touch.active) {
        if (!shouldCaptureCloseSwipe(dx, dy)) return;
        touch.active = true;
        dragEventsRef.current.begin();
      }
      dragEventsRef.current.move(dx);
    },
    onTouchEnd: (event: GestureResponderEvent) => {
      const touch = closeTouchRef.current;
      closeTouchRef.current = null;
      if (!touch?.active) return;
      const first = touch.samples[0];
      const last = touch.samples[touch.samples.length - 1];
      const elapsed = last.t - first.t;
      // px/ms over the last few samples, like PanResponder's `vx`.
      const vx = elapsed > 0 ? (last.x - first.x) / elapsed : 0;
      // The same release must not also count as a tap on the backdrop.
      suppressBackdropPressUntilRef.current = Date.now() + 300;
      dragEventsRef.current.end(event.nativeEvent.pageX - touch.x0, vx);
    },
    onTouchCancel: () => {
      const touch = closeTouchRef.current;
      closeTouchRef.current = null;
      if (!touch?.active) return;
      suppressBackdropPressUntilRef.current = Date.now() + 300;
      dragEventsRef.current.end(touch.samples[touch.samples.length - 1].x - touch.x0, 0);
    },
  };
  // The responders are created once, so they reach the latest closures here.
  const dragEventsRef = useRef({
    begin: beginDrawerDrag,
    move: moveDrawerDrag,
    end: endDrawerDrag,
  });
  dragEventsRef.current = {
    begin: beginDrawerDrag,
    move: moveDrawerDrag,
    end: endDrawerDrag,
  };

  useEffect(() => {
    if (showChatChrome) return;
    settleIdRef.current += 1;
    animatingRef.current = false;
    settledAtRef.current = 0;
    drawerProgress.stopAnimation();
    drawerProgress.setValue(0);
    setSessionsOpen(false);
  }, [drawerProgress, showChatChrome]);

  useEffect(() => {
    if (!sessionsOpen) return;
    void workspaceChats.refresh();
  }, [sessionsOpen, workspaceChats.refresh]);

  useEffect(() => {
    setExpandedProjectIds(new Set());
    setExpandedArchivedProjectIds(new Set());
    setProjectChats({});
  }, [workspace?.id]);

  useEffect(() => {
    if (!sessionsOpen || !workspace?.id) return;
    void projects.loadAll({ workspaceId: workspace.id }).catch(() => undefined);
  }, [projects, sessionsOpen, workspace?.id]);

  const openWorkspaceChat = (sessionId: string) => {
    closeSessions();
    workspaceChats.markSeen(sessionId);
    router.push({
      pathname: "/(app)/agent",
      params: { chatSessionId: sessionId },
    } as any);
  };

  // The chat the route opens is read, so a turn ending while it is on screen
  // clears its dot instead of flagging it as new activity.
  useEffect(() => {
    if (!routeParams.chatSessionId) return;
    workspaceChats.markSeen(routeParams.chatSessionId);
  }, [routeParams.chatSessionId, workspaceChats.markSeen]);

  const createSideChat = async () => {
    const session = await workspaceChats.createChat();
    if (!session) return;
    settleIdRef.current += 1;
    animatingRef.current = false;
    settledAtRef.current = 0;
    drawerProgress.setValue(0);
    setSessionsOpen(false);
    router.push({
      pathname: "/(app)/agent",
      params: { chatSessionId: session.id },
    } as any);
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

  useEffect(() => {
    return chatSessionEvents.subscribe(
      ({ projectId, workspaceId, refresh }) => {
        if (!refresh) return;
        if (!projectId) return;
        if (!projectChats[projectId] && !expandedProjectIds.has(projectId)) {
          return;
        }
        void loadProjectChats(projectId);
      },
    );
  }, [
    expandedProjectIds,
    loadProjectChats,
    projectChats,
    workspace?.id,
  ]);

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
      if (!chatSessions.get(sessionId)) {
        await chatSessions.loadById(sessionId);
      }
      await actions.updateChatSession(sessionId, changes);
      chatSessionEvents.emit({ projectId, refresh: true });
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
        ...(canProject(projectMenu.project, "project:update")
          ? [
              {
                label: "Rename",
                icon: <Pencil size={14} className="text-muted-foreground" />,
                onSelect: () => setRenamingProject(projectMenu.project),
              },
            ]
          : []),
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
        ...(canProject(projectMenu.project, "project:delete")
          ? [
              { separator: true as const },
              {
                label: "Delete",
                danger: true,
                icon: <Trash2 size={14} className="text-destructive" />,
                onSelect: () => deleteProject(projectMenu.project),
              },
            ]
          : []),
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
              className="absolute left-3 z-20 flex-row items-center gap-2"
              style={{ top: insets.top + 10 }}
            >
              {isProjectChatRoute ? (
                <NativeCircleButton
                  icon={ArrowLeft}
                  onPress={leaveProject}
                  accessibilityLabel="Back"
                  testID="project-chat-back"
                />
              ) : null}
              <PressableScale
                feedback={haptics.selection}
                accessibilityRole="button"
                accessibilityLabel={
                  sessionsOpen ? "Close chat sessions" : "Open chat sessions"
                }
                aria-expanded={sessionsOpen}
                onPress={() =>
                  sessionsOpen ? closeSessions() : openSessions()
                }
                className="h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-transparent active:bg-muted"
              >
                <LiquidGlassBackdrop style={{ borderRadius: 999 }} />
                <View>
                  <Menu
                    size={20}
                    color={icon.color}
                    strokeWidth={icon.strokeWidth}
                  />
                </View>
              </PressableScale>
            </View>
            {projectChatName ? (
              <View
                pointerEvents="none"
                className="absolute z-10 h-11 justify-center"
                style={{ top: insets.top + 10, left: 12 + 44 + 8 + 44 + 8, right: 12 + 44 + 8 }}
              >
                <Text
                  className="text-[17px] font-semibold text-foreground"
                  numberOfLines={1}
                  testID="project-chat-title"
                >
                  {projectChatName}
                </Text>
              </View>
            ) : null}
            <View
              className="absolute right-3 z-20 h-11 w-11 items-center justify-center rounded-full bg-transparent"
              style={{ top: insets.top + 10 }}
            >
              <View pointerEvents="none" className="absolute inset-0 overflow-hidden rounded-full">
                <LiquidGlassBackdrop style={{ borderRadius: 999 }} />
              </View>
              <NotificationBell size={NATIVE_PHONE_HEADER_ICON_SIZE} />
            </View>
          </>
        ) : null}
        <Modal
          visible={sessionsOpen}
          transparent
          presentationStyle="overFullScreen"
          animationType="none"
          onRequestClose={closeSessions}
          onDismiss={() => {
            if (!openWorkspaceSheetAfterDrawerDismissRef.current) return;
            openWorkspaceSheetAfterDrawerDismissRef.current = false;
            setWorkspaceSheetOpen(true);
          }}
        >
          {/* Close-swipe tracking sits on this container, above both the
              backdrop and the panel, so a left swipe anywhere on the overlay
              closes the drawer. */}
          <View className="flex-1" {...sessionDrawerCloseTouchHandlers}>
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
              onPress={() => {
                if (Date.now() < suppressBackdropPressUntilRef.current) return;
                closeSessions();
              }}
              // NativeWind's `absolute inset-0` does not apply reliably to
              // this Modal backdrop Pressable.
              style={StyleSheet.absoluteFill}
            />
            <Animated.View
              accessibilityViewIsModal
              className="z-10 h-full border-r border-border/70"
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
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel="Shogo Home"
                    onPress={() => {
                      closeSessions();
                      router.replace("/(app)" as any);
                    }}
                    className="h-11 w-11 items-center justify-center rounded-xl active:bg-muted"
                  >
                    <ShogoLogoMark className="h-6 w-6" />
                  </PressableScale>
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
                  {workspaceChats.loading ? (
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
                  ) : null}
                  <View className="mt-4">
                    <WorkspaceSidebarSection
                      label="Chats"
                      expanded={sideChatsExpanded}
                      onExpandedChange={setSideChatsExpanded}
                      headerClassName="px-3"
                      action={
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="New chat"
                          disabled={workspaceChats.creating}
                          onPress={() => void createSideChat()}
                          className="h-11 w-11 items-center justify-center rounded-lg active:bg-muted disabled:opacity-50"
                        >
                          {workspaceChats.creating ? (
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
                        <ChatSessionList
                          sessions={sideChats}
                          archivedSessions={[]}
                          renderAll
                          loaded={!workspaceChats.loading}
                          loadingLabel="Loading chats…"
                          emptyLabel={
                            sessionSearch.trim()
                              ? "No matching side chats."
                              : "No side chats yet."
                          }
                          streamingIds={workspaceChats.streamingIds}
                          completedIds={workspaceChats.completedIds}
                          onSelect={openWorkspaceChat}
                          onTogglePin={(id, next) =>
                            void workspaceChats.updateChat(id, { isPinned: next })
                          }
                          onRename={(id, name) =>
                            void workspaceChats.updateChat(id, { name })
                          }
                          onToggleArchive={(id, next) =>
                            void workspaceChats.updateChat(id, { isArchived: next })
                          }
                          onDeleteChat={(id) => void workspaceChats.deleteChat(id)}
                          rowClassName="min-h-0 rounded-xl px-3 py-1.5"
                          textClassName="text-base font-medium"
                          inactiveTextClassName="text-foreground"
                        />
                      </ScrollView>
                      {archivedSideChats.length > 0 ? (
                        <View className="mt-1">
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`${
                              showArchivedSideChats ? "Collapse" : "Expand"
                            } archived side chats`}
                            aria-expanded={showArchivedSideChats}
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
                              <ChatSessionList
                                sessions={archivedSideChats}
                                archivedSessions={[]}
                                renderAll
                                loaded={!workspaceChats.loading}
                                loadingLabel="Loading chats…"
                                emptyLabel="No archived chats."
                                streamingIds={workspaceChats.streamingIds}
                                completedIds={workspaceChats.completedIds}
                                onSelect={openWorkspaceChat}
                                onTogglePin={(id, next) =>
                                  void workspaceChats.updateChat(id, { isPinned: next })
                                }
                                onRename={(id, name) =>
                                  void workspaceChats.updateChat(id, { name })
                                }
                                onToggleArchive={(id, next) =>
                                  void workspaceChats.updateChat(id, { isArchived: next })
                                }
                                onDeleteChat={(id) => void workspaceChats.deleteChat(id)}
                                rowClassName="min-h-0 rounded-xl px-3 py-1.5"
                                textClassName="text-base font-medium"
                                inactiveTextClassName="text-foreground"
                              />
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
                              accessibilityLabel={`Open ${
                                project.name || "Untitled project"
                              }`}
                              onPress={() => {
                                if (
                                  suppressNextProjectToggleRef.current ===
                                  project.id
                                ) {
                                  suppressNextProjectToggleRef.current = null;
                                  return;
                                }
                                // Tapping the row opens the project; the
                                // chevron expands its chats.
                                closeSessions();
                                router.push({
                                  pathname: "/(app)/projects/[id]",
                                  params:
                                    Platform.OS === "web"
                                      ? { id: project.id }
                                      : {
                                          id: project.id,
                                          tab: "chat-fullscreen",
                                        },
                                } as any);
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
                                accessibilityLabel={`${
                                  expanded ? "Collapse" : "Expand"
                                } chats for ${
                                  project.name || "Untitled project"
                                }`}
                                aria-expanded={expanded}
                                onPress={(event) => {
                                  event.stopPropagation?.();
                                  toggleProjectChats(project.id);
                                }}
                                className="h-8 w-8 items-center justify-center rounded-lg active:bg-muted"
                              >
                                {expanded ? (
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
                              </Pressable>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`Create a new chat in ${
                                  project.name || "this project"
                                }`}
                                onPress={(event) => {
                                  event.stopPropagation?.();
                                  startProjectChat(project.id);
                                }}
                                // Hover-only on web, but the slot stays in the
                                // layout so the row does not grow. Always
                                // visible on touch.
                                className={
                                  Platform.OS === "web"
                                    ? "h-8 w-8 items-center justify-center rounded-lg active:bg-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
                                    : "h-8 w-8 items-center justify-center rounded-lg active:bg-muted"
                                }
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
                                          aria-expanded={archivedChatsExpanded}
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
          onRename={
            canProject(nativeProjectActions, "project:update")
              ? () => {
                  setRenamingProject(nativeProjectActions);
                  setNativeProjectActions(null);
                }
              : undefined
          }
          onTogglePin={() => {
            if (!nativeProjectActions) return;
            toggleProjectPin(
              nativeProjectActions.id,
              !pinnedProjectIds.has(nativeProjectActions.id)
            );
          }}
          onDelete={
            canProject(nativeProjectActions, "project:delete")
              ? () => {
                  if (nativeProjectActions) deleteProject(nativeProjectActions);
                }
              : undefined
          }
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
