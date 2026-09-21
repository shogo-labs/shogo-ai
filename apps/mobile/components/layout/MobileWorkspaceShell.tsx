// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phone and narrow-web chrome for Workspace Agent Chat. Desktop owns the
 * rail/context/inspector composition; this shell deliberately keeps one
 * focused transcript with a session drawer trigger and compact workspace
 * identity.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { Folder, Menu, Plus, Search } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDomainHttp, useProjectCollection } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { api } from "../../lib/api";
import { NotificationBell } from "../notifications/NotificationBell";
import {
  NATIVE_PHONE_HEADER_ICON_SIZE,
  useNativePhoneIconChrome,
} from "../../lib/native-phone-layout";
import { WorkspaceSidebarSection } from "./WorkspaceSidebarSection";
import { MobileWorkspaceChromeProvider } from "./MobileWorkspaceChromeContext";
import { ShogoLogoMark } from "../branding/ShogoLogoMark";

interface MobileWorkspaceShellProps {
  children: ReactNode;
}

export function MobileWorkspaceShell({ children }: MobileWorkspaceShellProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const icon = useNativePhoneIconChrome();
  const http = useDomainHttp();
  const workspace = useActiveWorkspace();
  const projects = useProjectCollection();
  const prefersReducedMotion = useReducedMotion();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const drawerProgress = useRef(new Animated.Value(0)).current;
  const [sessions, setSessions] = useState<
    Array<{
      id: string;
      name?: string | null;
      inferredName?: string | null;
      isPrimary?: boolean;
    }>
  >([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sideChatsExpanded, setSideChatsExpanded] = useState(true);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [showAllSideChats, setShowAllSideChats] = useState(false);
  const filteredSessions = sessions.filter((session) => {
    const label = session.name || session.inferredName || "Untitled side chat";
    return label.toLowerCase().includes(sessionSearch.trim().toLowerCase());
  });
  const sideChats = filteredSessions.filter((session) => !session.isPrimary);
  const visibleSideChats =
    showAllSideChats || sessionSearch.trim()
      ? sideChats
      : sideChats.slice(0, 5);
  const workspaceProjects = projects.all.filter(
    (project: any) => project.workspaceId === workspace?.id
  );
  const drawerWidth = Math.min(width * 0.86, 360);

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

  return (
    <MobileWorkspaceChromeProvider>
      <View className="relative flex-1 bg-background">
        <View className="min-h-0 flex-1">{children}</View>
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
            onPress={() => (sessionsOpen ? closeSessions() : openSessions())}
            className="h-11 w-11 items-center justify-center rounded-full border border-border/70 bg-card/95 active:bg-muted"
          >
            <Menu size={20} color={icon.color} strokeWidth={icon.strokeWidth} />
          </Pressable>
        </View>
        <View
          className="absolute right-3 z-20 h-11 w-11 items-center justify-center rounded-full border border-border/70 bg-card/95"
          style={{ top: insets.top + 10 }}
        >
          <NotificationBell size={NATIVE_PHONE_HEADER_ICON_SIZE} />
        </View>
        <Modal
          visible={sessionsOpen}
          transparent
          animationType="none"
          onRequestClose={closeSessions}
        >
          <View className="absolute inset-0">
            <Animated.View
              className="absolute inset-0 bg-black/40"
              style={{
                opacity: drawerProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 1],
                }),
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close chat drawer"
              onPress={closeSessions}
              className="absolute inset-0"
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
                <View className="mx-4 flex-row items-center gap-2">
                  <ShogoLogoMark className="h-5 w-5" />
                  <View className="min-w-0 flex-1 flex-row items-center gap-2 rounded-2xl border border-border/70 bg-background px-3 py-2">
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
                      className="min-w-0 flex-1 text-sm text-foreground"
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
                  {sessions
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
                        <Text className="text-sm font-semibold text-foreground">
                          Main chat
                        </Text>
                      </Pressable>
                    ))}
                  <View className="mt-4">
                    <WorkspaceSidebarSection
                      label="Side chats"
                      count={sideChats.length}
                      expanded={sideChatsExpanded}
                      onExpandedChange={setSideChatsExpanded}
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
                      {visibleSideChats.map((session) => (
                        <Pressable
                          key={session.id}
                          accessibilityRole="link"
                          accessibilityLabel={`Open side chat ${
                            session.name ||
                            session.inferredName ||
                            "Untitled side chat"
                          }`}
                          onPress={() => {
                            closeSessions();
                            router.push({
                              pathname: "/(app)/side-chats/[id]",
                              params: { id: session.id },
                            } as any);
                          }}
                          className="rounded-xl px-3 py-3 active:bg-muted"
                        >
                          <Text
                            className="text-sm font-medium text-foreground"
                            numberOfLines={1}
                          >
                            {session.name ||
                              session.inferredName ||
                              "Untitled side chat"}
                          </Text>
                        </Pressable>
                      ))}
                      {sideChats.length > 5 && !sessionSearch.trim() ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            showAllSideChats
                              ? "Show fewer side chats"
                              : "Show all side chats"
                          }
                          onPress={() =>
                            setShowAllSideChats((showAll) => !showAll)
                          }
                          className="min-h-11 justify-center rounded-lg px-3 active:bg-muted"
                        >
                          <Text className="text-xs font-medium text-primary">
                            {showAllSideChats ? "Show less" : "Show more"}
                          </Text>
                        </Pressable>
                      ) : null}
                      {!loadingSessions && sideChats.length === 0 ? (
                        <Text className="px-3 py-3 text-sm text-muted-foreground">
                          {sessionSearch.trim()
                            ? "No matching side chats."
                            : "No side chats yet."}
                        </Text>
                      ) : null}
                    </WorkspaceSidebarSection>
                  </View>

                  <View className="mt-3">
                    <WorkspaceSidebarSection
                      label="Projects"
                      count={workspaceProjects.length}
                      expanded={projectsExpanded}
                      onExpandedChange={setProjectsExpanded}
                      action={
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Create a new project"
                          onPress={() =>
                            router.push("/(app)/new-project" as any)
                          }
                          className="h-11 w-11 items-center justify-center rounded-lg active:bg-muted"
                        >
                          <Plus size={17} color={icon.color} />
                        </Pressable>
                      }
                    >
                      {workspaceProjects.map((project: any) => (
                        <Pressable
                          key={project.id}
                          accessibilityRole="link"
                          accessibilityLabel={`Open project ${
                            project.name || "Untitled project"
                          }`}
                          onPress={() => {
                            closeSessions();
                            router.push({
                              pathname: "/(app)/projects/[id]",
                              params: { id: project.id },
                            } as any);
                          }}
                          className="flex-row items-center gap-2 rounded-xl px-3 py-3 active:bg-muted"
                        >
                          <Folder size={16} color={icon.color} />
                          <Text
                            className="flex-1 text-sm font-medium text-foreground"
                            numberOfLines={1}
                          >
                            {project.name || "Untitled project"}
                          </Text>
                        </Pressable>
                      ))}
                      {workspaceProjects.length === 0 ? (
                        <Text className="px-3 py-3 text-sm text-muted-foreground">
                          No projects yet.
                        </Text>
                      ) : null}
                    </WorkspaceSidebarSection>
                  </View>
                </ScrollView>
              </View>
            </Animated.View>
          </View>
        </Modal>
      </View>
    </MobileWorkspaceChromeProvider>
  );
}
