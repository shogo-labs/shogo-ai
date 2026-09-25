// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import {
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Activity,
  ClipboardList,
  FileText,
  LayoutGrid,
  ListTodo,
  MessageCircle,
  Settings,
  Target,
} from "lucide-react-native";
import { NativePhoneBottomFade } from "../phone/NativePhoneBottomFade";
import { MobileSettingsSheet } from "./MobileSettingsSheet";
import {
  LiquidGlassBackdrop,
  supportsLiquidGlass,
} from "../ui/LiquidGlassBackdrop";
import { cn } from "@shogo/shared-ui/primitives";
import { useResolvedTheme } from "../../contexts/theme";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import {
  setLastProjectContext,
  useLastProjectContext,
} from "../../hooks/useLastProjectContext";
import type { BottomTabId } from "@shogo/shared-app";
import {
  CHAT_TRANSCRIPT_MAX_WIDTH,
  nativeComposerKeyboardOpenFromSource,
} from "../../lib/native-composer-keyboard";
import {
  nativeComposerKeyboardOverlapFromEvent,
  useNativeComposerKeyboard,
} from "../../lib/use-native-composer-keyboard";
import {
  NATIVE_PHONE_COMPOSER_PILL_HEIGHT,
  NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET,
  NATIVE_PHONE_DOCK_FADE,
  NATIVE_PHONE_GUTTER,
  NATIVE_PHONE_HOME_CANVAS,
  WEB_WIDE_MIN_WIDTH,
} from "../../lib/native-phone-layout";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isProjectPath(pathname: string) {
  return /\/(?:projects|project-chat|project-surface)\/[^/?]+/.test(pathname);
}

function isHomePath(pathname: string) {
  return (
    pathname === "/" || pathname === "/(app)" || pathname === "/(app)/index"
  );
}

function isBottomTabPath(pathname: string) {
  return ["/tasks", "/activity", "/canvases", "/goals"].some(
    (path) =>
      pathname === path ||
      pathname.endsWith(path) ||
      pathname.includes(`(app)${path}`)
  );
}

function projectIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(
    /\/(?:projects|project-chat|project-surface)\/([^/?]+)/
  );
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function isHiddenPath(pathname: string) {
  return [
    "/settings",
    "/billing",
    "/account",
    "/profile",
    "/api-keys",
    "/search",
    "/notifications",
    "/project-chats",
    "/members",
    "/new-workspace",
    "/remote-control",
  ].some(
    (path) =>
      pathname === path ||
      pathname.startsWith(`${path}/`) ||
      pathname.includes(`(app)${path}`)
  );
}

export function MobileBottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const experience = useWorkspaceExperience();
  // This component lives in the app layout rather than in the leaf project
  // surface route. Local params therefore remain stale after switching to a
  // canvas/files/plans surface; global params track the focused route.
  const params = useGlobalSearchParams<{
    id?: string;
    chatSessionId?: string;
    projectId?: string;
    returnProjectId?: string;
    returnChatSessionId?: string;
    tab?: string;
    surface?: string;
    navTab?: string;
    projectSettings?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isDark = useResolvedTheme() === "dark";
  const liquidGlass = supportsLiquidGlass();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openProjectSettings, setOpenProjectSettings] = useState(false);
  const handledProjectSettingsRef = useRef<string | null>(null);
  const lastProjectContext = useLastProjectContext();

  const routeProjectId = firstParam(params.id);
  const tabProjectId =
    firstParam(params.returnProjectId) ?? firstParam(params.projectId);
  const pathnameProjectId = projectIdFromPath(pathname);
  const activeProjectId = routeProjectId ?? pathnameProjectId;
  const chatSessionId =
    firstParam(params.chatSessionId) ?? firstParam(params.returnChatSessionId);
  const projectMode = isProjectPath(pathname) && !!activeProjectId;

  useEffect(() => {
    const request = firstParam(params.projectSettings);
    if (!request || !projectMode || !activeProjectId) return;
    if (handledProjectSettingsRef.current === request) return;
    handledProjectSettingsRef.current = request;
    setOpenProjectSettings(true);
    setSettingsOpen(true);
  }, [activeProjectId, params.projectSettings, projectMode]);

  useEffect(() => {
    if (activeProjectId && isProjectPath(pathname)) {
      setLastProjectContext({
        projectId: activeProjectId,
        ...(chatSessionId ? { chatSessionId } : {}),
      });
    } else if (tabProjectId && isBottomTabPath(pathname)) {
      // Keep the context alive even if the app layout remounts while moving
      // between bottom tabs. The params are passed by the tab buttons below.
      setLastProjectContext({
        projectId: tabProjectId,
        ...(chatSessionId ? { chatSessionId } : {}),
      });
    } else if (isHomePath(pathname)) {
      // Re-entering Home intentionally resets the context. The other bottom
      // tabs preserve the last project context while opened from a project,
      // so Chat can return to that project.
      setLastProjectContext(null);
    }
  }, [activeProjectId, chatSessionId, pathname, tabProjectId]);

  // Prefer the current project route immediately, before the effect above
  // has necessarily populated the cross-tab context. This prevents the first
  // bottom-nav tap after entering a project from falling back to Home.
  const currentProjectContext =
    isProjectPath(pathname) && activeProjectId
      ? {
          projectId: activeProjectId,
          ...(chatSessionId ? { chatSessionId } : {}),
        }
      : isBottomTabPath(pathname) && tabProjectId
      ? { projectId: tabProjectId, ...(chatSessionId ? { chatSessionId } : {}) }
      : lastProjectContext;

  // On native this mirrors RN `Keyboard` show/hide 1:1. On web (no `Keyboard`
  // bridge) the same hook tracks `visualViewport` shrinking instead — see
  // use-native-composer-keyboard.ts — so the nav hides for the on-screen
  // keyboard on mobile web too, not just the native app.
  useNativeComposerKeyboard(true, (event, source) => {
    const overlap = nativeComposerKeyboardOverlapFromEvent(event);
    const open = nativeComposerKeyboardOpenFromSource(source, overlap, 0);
    if (open != null) setKeyboardOpen(open);
  });

  const active = useMemo(() => {
    if (settingsOpen) return "more";
    if (projectMode) {
      const tab =
        firstParam(params.navTab) ??
        firstParam(params.surface) ??
        firstParam(params.tab);
      if (tab === "canvas" || tab === "external-preview" || tab === "app-preview")
        return "canvas";
      if (tab === "files" || tab === "plans") return tab;
      return "chat";
    }
    if (pathname.includes("/tasks")) return "tasks";
    if (pathname.includes("/goals")) return "goals";
    if (pathname.includes("/activity")) return "activity";
    if (pathname.includes("/canvases")) return "canvases";
    if (pathname.includes("/settings")) return "more";
    if (pathname.includes("/marketplace")) return "none";
    return "chat";
  }, [
    params.navTab,
    params.surface,
    params.tab,
    pathname,
    projectMode,
    settingsOpen,
  ]);

  if (Platform.OS === "web" && width >= WEB_WIDE_MIN_WIDTH) return null;
  if (isHiddenPath(pathname) || keyboardOpen) return null;

  const goChat = () => {
    if (
      experience.chatReturnsToProjectContext &&
      currentProjectContext?.projectId
    ) {
      router.replace({
        pathname: "/(app)/project-chat/[id]" as any,
        params: {
          id: currentProjectContext.projectId,
          ...(currentProjectContext.chatSessionId
            ? { chatSessionId: currentProjectContext.chatSessionId }
            : {}),
        },
      } as any);
    } else {
      router.replace("/(app)" as any);
    }
  };

  const goProjectChat = () => {
    if (!activeProjectId) return;
    router.replace({
      pathname: "/(app)/project-chat/[id]" as any,
      params: {
        id: activeProjectId,
        ...(chatSessionId ? { chatSessionId } : {}),
      },
    } as any);
  };

  const openProjectSurface = (tab: "canvas" | "files" | "plans") => {
    if (!activeProjectId) return;
    router.replace({
      pathname: "/(app)/project-surface/[id]" as any,
      params: {
        id: activeProjectId,
        ...(chatSessionId ? { chatSessionId } : {}),
        surface: tab,
        navTab: tab,
      },
    } as any);
  };

  const taskItem = {
    id: "tasks",
    label: "Tasks",
    Icon: ListTodo,
    onPress: () => {
      const context = currentProjectContext;
      router.push({
        pathname: "/(app)/tasks" as any,
        ...(context?.projectId
          ? {
              params: {
                projectId: context.projectId,
                returnChatSessionId: context.chatSessionId,
              },
            }
          : {}),
      } as any);
    },
  };

  const chatItem = {
    id: "chat",
    label: "Chat",
    Icon: MessageCircle,
    onPress: goChat,
  };
  const activityItem = {
    id: "activity",
    label: "Activity",
    Icon: Activity,
    onPress: () =>
      router.push({
        pathname: "/(app)/activity" as any,
        ...(currentProjectContext?.projectId
          ? {
              params: {
                returnProjectId: currentProjectContext.projectId,
                returnChatSessionId: currentProjectContext.chatSessionId,
              },
            }
          : {}),
      } as any),
  };
  const goalsItem = {
    id: "goals",
    label: "Goals",
    Icon: Target,
    onPress: () => router.push("/(app)/goals" as any),
  };
  const canvasesItem = {
    id: "canvases",
    label: "Canvases",
    Icon: LayoutGrid,
    onPress: () =>
      router.push({
        pathname: "/(app)/canvases" as any,
        ...(currentProjectContext?.projectId
          ? {
              params: {
                returnProjectId: currentProjectContext.projectId,
                returnChatSessionId: currentProjectContext.chatSessionId,
              },
            }
          : {}),
      } as any),
  };
  const moreItem = {
    id: "more",
    label: "More",
    Icon: Settings,
    onPress: () => {
      setOpenProjectSettings(false);
      setSettingsOpen(true);
    },
  };
  const projectItems = [
    {
      id: "chat",
      label: "Chat",
      Icon: MessageCircle,
      onPress: goProjectChat,
    },
    {
      id: "canvas",
      label: "Canvas",
      Icon: LayoutGrid,
      onPress: () => openProjectSurface("canvas"),
    },
    {
      id: "files",
      label: "Files",
      Icon: FileText,
      onPress: () => openProjectSurface("files"),
    },
    {
      id: "plans",
      label: "Plans",
      Icon: ClipboardList,
      onPress: () => openProjectSurface("plans"),
    },
    moreItem,
  ];

  // The team vs. personal tab set (and order) is owned by the experience
  // descriptor (`bottomTabs`); this map just supplies the onPress/icon for
  // whichever ids it lists, so adding a workspace-experience tab elsewhere
  // doesn't require touching this component's branching logic.
  const tabsById: Record<
    BottomTabId,
    {
      id: string;
      label: string;
      Icon: typeof MessageCircle;
      onPress: () => void;
    }
  > = {
    chat: chatItem,
    tasks: taskItem,
    activity: activityItem,
    canvases: canvasesItem,
    goals: goalsItem,
    more: moreItem,
  };
  const items = projectMode
    ? projectItems
    : experience.bottomTabs.map((id) => tabsById[id]);

  return (
    <>
      <View
        className="bg-transparent pt-1"
        style={{
          position: "relative",
          // The composer already reserves bottom padding. Offset the nav by
          // that amount so the resulting visible gap is one compact text line.
          marginTop: -12,
          // Home is edge-to-edge in the root shell, while project chat is
          // already inside the shell's bottom safe area. Reserve the home
          // inset here so the composer and this capsule move up together and
          // match the project-chat dock position.
          paddingBottom: isHomePath(pathname) ? insets.bottom + 8 : 8,
          paddingHorizontal: NATIVE_PHONE_GUTTER,
        }}
        testID="mobile-bottom-nav"
      >
        {!isProjectPath(pathname) ? (
          <NativePhoneBottomFade
            isDark={isDark}
            canvasHex={
              isHomePath(pathname) && isDark
                ? NATIVE_PHONE_HOME_CANVAS
                : undefined
            }
            height={
              NATIVE_PHONE_DOCK_FADE + NATIVE_PHONE_COMPOSER_PILL_HEIGHT + 16
            }
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          />
        ) : null}
        <View
          className={cn(
            "w-full flex-row items-center gap-1 overflow-hidden px-1.5 shadow-sm",
            liquidGlass ? "bg-transparent" : "bg-card/95"
          )}
          style={{
            height: NATIVE_PHONE_COMPOSER_PILL_HEIGHT,
            maxWidth: CHAT_TRANSCRIPT_MAX_WIDTH,
            alignSelf: "center",
            borderRadius: NATIVE_PHONE_COMPOSER_PILL_HEIGHT / 2,
          }}
        >
          <LiquidGlassBackdrop
            tintColor={
              isDark ? "rgba(28,28,30,0.42)" : "rgba(255,255,255,0.42)"
            }
            style={{
              borderRadius: NATIVE_PHONE_COMPOSER_PILL_HEIGHT / 2,
            }}
          />
          {items.map(({ id, label, Icon, onPress }) => {
            const selected = active === id;
            return (
              <Pressable
                key={id}
                onPress={onPress}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
                className={cn(
                  "flex-1 items-center justify-center rounded-full",
                  selected && "bg-primary/10"
                )}
                style={{
                  height:
                    NATIVE_PHONE_COMPOSER_PILL_HEIGHT -
                    NATIVE_PHONE_COMPOSER_PILL_ITEM_INSET * 2,
                }}
              >
                <Icon
                  size={23}
                  color={
                    selected
                      ? isDark
                        ? "#F09050"
                        : "#E27927"
                      : isDark
                      ? "#a1a1aa"
                      : "#6b7280"
                  }
                  strokeWidth={selected ? 2.2 : 1.9}
                />
              </Pressable>
            );
          })}
        </View>
      </View>
      <MobileSettingsSheet
        visible={settingsOpen}
        projectId={projectMode ? activeProjectId : undefined}
        openProjectSettings={openProjectSettings}
        onClose={() => {
          setSettingsOpen(false);
          setOpenProjectSettings(false);
        }}
      />
    </>
  );
}
