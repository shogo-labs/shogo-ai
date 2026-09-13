// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppSidebar - Responsive navigation sidebar matching staging design
 *
 * This module owns responsive shell rendering and workspace/invite/billing/
 * project-filter state. Leaf UI and tree components live alongside it.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  BackHandler,
  useWindowDimensions,
  Platform,
} from "react-native";
import { usePostHogSafe } from "../../../contexts/posthog";
import { useResolvedTheme } from "../../../contexts/theme";
import { EVENTS, trackEvent } from "../../../lib/analytics";
import { formatModKey } from "../../../lib/keyboard-shortcuts";
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "@/components/ui/popover";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { observer } from "mobx-react-lite";
import {
  Home,
  Search,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  Plus,
  Inbox,
  Store,
  Mic,
  Laptop,
  SlidersHorizontal,
  Check,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { CommandPalette, useCommandPalette } from "../CommandPalette";
import { useActiveInstance } from "../../../contexts/active-instance";
import { ShogoWordmark } from "../../branding/ShogoWordmark";
import { useAuth } from "../../../contexts/auth";
import {
  useProjectCollection,
  useWorkspaceCollection,
  useDomainActions,
  useDomainHttp,
} from "../../../contexts/domain";
import { useBillingData } from "@shogo/shared-app/hooks";
import { NotificationBell } from "../../notifications/NotificationBell";
import { api } from "../../../lib/api";
import { trackPurchase } from "../../../lib/tracking";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  resolveActiveWorkspaceId,
  subscribeActiveWorkspaceId,
} from "../../../lib/workspace-store";
import { scheduleWorkspaceSwitch } from "../../../lib/switch-workspace";
import { workspaceProjectFilter } from "../../../lib/project-load";
import { usePlatformConfig } from "../../../lib/platform-config";
import {
  nativePhoneCanvas,
  WEB_WIDE_MIN_WIDTH,
  useNativePhoneIconChrome,
} from "../../../lib/native-phone-layout";
import { densityFor } from "../../../lib/phone-density";
import {
  nativeDrawerFooterInset,
  nativeDrawerSideInset,
  nativeDrawerTopInset,
} from "../../../lib/use-native-drawer-swipe";
import { invitationEvents } from "../../../lib/invitation-events";
import {
  effectiveSidebarProjectFilter,
  getPinnedProjectIds,
  setPinnedProjectIds,
  getProjectFilter,
  setProjectFilter,
  type ProjectSort,
  type ProjectScope,
} from "../../../lib/project-prefs-store";
import { NavItem } from "./NavItem";
import { ProjectTreeItem } from "./ProjectTreeItem";
import {
  MENU_ITEM_RADIO_ROLE,
  PROJECT_SCOPE_OPTIONS,
  PROJECT_SORT_OPTIONS,
} from "./ProjectFilterSheet";
import { AccountMenu } from "./AccountMenu";
import { CreateWorkspaceModal } from "./CreateWorkspaceModal";
import { InboxPanel } from "./InboxPanel";
import { useHasAdminAccess } from "../../../hooks/useHasAdminAccess";
import { useWorkspacePlans } from "../../../hooks/useWorkspacePlans";

// Cap the projects list; pinned + the open project always show, the rest
// collapse behind a "More" toggle.
const MAX_VISIBLE_PROJECTS = 5;

function SectionDisclosureChevron({
  expanded,
  size,
}: {
  expanded: boolean;
  size: number;
}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return <Icon size={size} className="text-muted-foreground shrink-0" />;
}

// ─── Main AppSidebar ───────────────────────────────────────

interface AppSidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
  /** Override drawer rendering for responsive or embedded surfaces. */
  isNativeDrawer?: boolean;
}

export const AppSidebar = observer(function AppSidebar({
  isOpen,
  onClose,
  isNativeDrawer: nativeDrawerOverride,
}: AppSidebarProps) {
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isWide = Platform.OS === "web" && width >= WEB_WIDE_MIN_WIDTH;
  const isNativeDrawer = nativeDrawerOverride ?? !isWide;
  const isDark = useResolvedTheme() === "dark";
  const iconChrome = useNativePhoneIconChrome();
  const drawerDensity = densityFor(isNativeDrawer);
  const sectionChevronSize = isNativeDrawer ? drawerDensity.icon.sm : 12;
  const nativeDrawerCanvas = nativePhoneCanvas(isDark);
  const drawerTopInset = isNativeDrawer
    ? nativeDrawerTopInset(insets.top)
    : insets.top;
  // Sit above the home indicator / rounded corner without the extra min-height
  // padding that used to look like a second empty row.
  const drawerFooterInset = isNativeDrawer
    ? nativeDrawerFooterInset(insets.bottom)
    : insets.bottom;
  const drawerSideInset = isNativeDrawer
    ? nativeDrawerSideInset(insets.left)
    : 0;
  const { features, localMode } = usePlatformConfig();

  const { user, signOut } = useAuth();
  // Full super admins and users with any assigned admin scope.
  const hasAdminAccess = useHasAdminAccess(user?.id);
  const posthog = usePostHogSafe();
  const projects = useProjectCollection();
  const workspaces = useWorkspaceCollection();
  const actions = useDomainActions();
  const http = useDomainHttp();

  const [pendingInvites, setPendingInvites] = useState<any[]>([]);
  const [processingInvite, setProcessingInvite] = useState<{
    id: string;
    action: "accept" | "decline";
  } | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);

  useEffect(() => {
    // Chain projects after workspaces so that, on a fresh first load where
    // no active workspace has been persisted yet, we can still scope to
    // the first workspace the user belongs to. `resolveActiveWorkspaceId`
    // also self-heals a persisted id that isn't one of *this* user's
    // workspaces (e.g. left over from a different account on the same
    // browser) instead of feeding it straight to the API and getting
    // "Access denied to this workspace" on every request.
    workspaces
      .loadAll()
      .then(() => {
        const ownIds = (workspaces.all ?? []).map((w: any) => w.id);
        const wsId = resolveActiveWorkspaceId(ownIds);
        const filter = workspaceProjectFilter(wsId);
        if (filter) {
          projects
            .loadAll(filter)
            .catch((e) =>
              console.error("[AppSidebar] Failed to load projects:", e),
            );
        }
      })
      .catch((e) =>
        console.error("[AppSidebar] Failed to load workspaces:", e),
      );
  }, []);

  const loadInvites = useCallback(() => {
    if (!http || !user?.email) return;
    api
      .getReceivedInvitations(http, user.email)
      .then(setPendingInvites)
      .catch((e) =>
        console.error("[AppSidebar] Failed to load invitations:", e),
      );
  }, [http, user?.email]);

  const acceptInvite = useCallback(
    async (invite: any) => {
      setProcessingInvite({ id: invite.id, action: "accept" });
      try {
        await actions.acceptInvitation(invite.id, user?.id || "", {
          workspaceId: invite.workspaceId,
          role: invite.role,
          projectId: invite.projectId,
        });
        setPendingInvites((prev) =>
          prev.filter((item: any) => item.id !== invite.id),
        );
      } catch {}
      loadInvites();
      invitationEvents.emit();
      workspaces
        .loadAll()
        .catch((e) =>
          console.error("[AppSidebar] Failed to reload workspaces:", e),
        );
      setProcessingInvite(null);
    },
    [actions, loadInvites, user?.id, workspaces],
  );

  const declineInvite = useCallback(
    async (invite: any) => {
      setProcessingInvite({ id: invite.id, action: "decline" });
      try {
        await actions.declineInvitation(invite.id);
        setPendingInvites((prev) =>
          prev.filter((item: any) => item.id !== invite.id),
        );
      } catch {}
      loadInvites();
      invitationEvents.emit();
      setProcessingInvite(null);
    },
    [actions, loadInvites],
  );

  useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  useEffect(() => invitationEvents.subscribe(loadInvites), [loadInvites]);

  // Detect return from Stripe checkout: verify payment, provision subscription, reload
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    const wsId = params.get("workspace");
    const sessionId = params.get("session_id");
    if (
      (checkout === "workspace_created" || checkout === "success") &&
      wsId &&
      sessionId
    ) {
      const provision = async () => {
        try {
          const result = await api.verifyCheckout(http, sessionId);
          trackPurchase({
            planId: result.planId,
            workspaceId: wsId,
            sessionId,
          });
        } catch {
          /* webhook will handle it */
        }
        window.location.href = `/?workspace=${wsId}`;
      };
      provision();
    } else if (params.get("workspace") && !params.get("checkout")) {
      const targetWs = params.get("workspace")!;
      workspaces.loadAll().then(() => {
        // Only trust `?workspace=` once it's confirmed to be one of *this*
        // user's own workspaces — an invite/share link pointing at a
        // workspace this session isn't a member of would otherwise get
        // persisted as "active" and 403/400 every request from then on.
        const ownIds = (workspaces.all ?? []).map((w: any) => w.id);
        const resolvedWs = resolveActiveWorkspaceId(ownIds, targetWs);
        if (!resolvedWs) return;
        setSelectedWorkspaceId(resolvedWs);
        setActiveWorkspaceId(resolvedWs);
        projects
          .loadAll({ workspaceId: resolvedWs })
          .catch((e) =>
            console.error(
              "[AppSidebar] Failed to load projects for workspace:",
              e,
            ),
          );
      });
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => getActiveWorkspaceId(),
  );

  useEffect(() => {
    return subscribeActiveWorkspaceId(() => {
      const id = getActiveWorkspaceId();
      if (id) setSelectedWorkspaceId(id);
    });
  }, []);

  let currentWorkspace: any;
  try {
    const ownWorkspaces = workspaces?.all ?? [];
    currentWorkspace = selectedWorkspaceId
      ? ownWorkspaces.find((w: any) => w.id === selectedWorkspaceId)
      : undefined;
    // `selectedWorkspaceId` may be a stale id (a different account's
    // workspace persisted on this browser, or an unverified `?workspace=`
    // link) that never matches this user's own list. Once the user's own
    // workspaces have actually loaded, fall back to the first one rather
    // than leaving `currentWorkspace` permanently undefined — otherwise
    // every workspace-scoped fetch below keeps targeting the invalid id.
    if (!currentWorkspace && ownWorkspaces.length > 0) {
      currentWorkspace = ownWorkspaces[0];
    }
  } catch {
    currentWorkspace = undefined;
  }

  const activeWorkspaceId = currentWorkspace?.id ?? selectedWorkspaceId;

  const billingData = useBillingData(
    features.billing ? currentWorkspace?.id : undefined,
  );

  // Device-local projects-list prefs (pins + filter) seeded from storage.
  const [pinnedProjectIds, setPinnedProjectIdsState] = useState<Set<string>>(
    () => new Set(getPinnedProjectIds()),
  );
  const [projectFilter, setProjectFilterState] = useState(() =>
    getProjectFilter(),
  );
  // Native phone has no filter/sort control; always show recent + all.
  const listFilter = effectiveSidebarProjectFilter(projectFilter);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  const toggleProjectsExpanded = useCallback(() => {
    setProjectsExpanded((expanded) => !expanded);
  }, []);

  const handleToggleProjectPin = useCallback(
    (projectId: string, next: boolean) => {
      setPinnedProjectIdsState((prev) => {
        const updated = new Set(prev);
        if (next) updated.add(projectId);
        else updated.delete(projectId);
        setPinnedProjectIds(Array.from(updated));
        return updated;
      });
    },
    [],
  );

  const updateProjectFilter = useCallback(
    (patch: Partial<{ sort: ProjectSort; scope: ProjectScope }>) => {
      setProjectFilterState((prev) => {
        const next = { ...prev, ...patch };
        setProjectFilter(next);
        return next;
      });
    },
    [],
  );

  let workspaceProjects: any[];
  try {
    const all = projects?.all ?? [];
    const workspaceScoped = activeWorkspaceId
      ? all.filter((p: any) => p.workspaceId === activeWorkspaceId)
      : all;
    const scopeFiltered =
      listFilter.scope === "mine" && user?.id
        ? workspaceScoped.filter((p: any) => p.createdBy === user.id)
        : workspaceScoped;
    const sorted = [...scopeFiltered].sort((a: any, b: any) => {
      if (listFilter.sort === "name") {
        return String(a.name || "").localeCompare(String(b.name || ""));
      }
      const aTime = a.lastMessageAt || a.updatedAt || 0;
      const bTime = b.lastMessageAt || b.updatedAt || 0;
      return bTime - aTime;
    });
    // Float pinned projects to the top. Array.sort is stable, so the chosen
    // sort order is preserved within the pinned / unpinned groups.
    workspaceProjects = sorted.sort((a: any, b: any) => {
      const ap = pinnedProjectIds.has(a.id) ? 1 : 0;
      const bp = pinnedProjectIds.has(b.id) ? 1 : 0;
      return bp - ap;
    });
  } catch {
    workspaceProjects = [];
  }

  // Keep pinned projects in their own section. Only unpinned projects are
  // subject to the "More" cap, so pinning a project never duplicates it in
  // the regular Projects section or hides it behind the cap.
  const pinnedProjects = workspaceProjects.filter((project: any) =>
    pinnedProjectIds.has(project.id),
  );
  const unpinnedProjects = workspaceProjects.filter(
    (project: any) => !pinnedProjectIds.has(project.id),
  );
  const visibleUnpinnedProjects = (() => {
    if (showAllProjects || unpinnedProjects.length <= MAX_VISIBLE_PROJECTS) {
      return unpinnedProjects;
    }
    const head = unpinnedProjects.slice(0, MAX_VISIBLE_PROJECTS);
    const headIds = new Set(head.map((project: any) => project.id));
    const activeProject = unpinnedProjects.find((project: any) =>
      pathname.includes(project.id),
    );
    return activeProject && !headIds.has(activeProject.id)
      ? [...head, activeProject]
      : head;
  })();
  const hiddenProjectCount =
    unpinnedProjects.length - visibleUnpinnedProjects.length;

  const [collapsed, setCollapsed] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } =
    useCommandPalette();
  const { instance: activeRemoteInstance } = useActiveInstance();

  let allWorkspaces: any[];
  try {
    allWorkspaces = workspaces?.all?.slice() ?? [];
  } catch {
    allWorkspaces = [];
  }

  const allPlans = useWorkspacePlans(
    allWorkspaces.map((w: any) => w.id),
    !!features.billing,
    billingData.subscription?.planId,
  );

  const workspacePlan = currentWorkspace?.id
    ? (allPlans[currentWorkspace.id] ?? null)
    : null;
  const isPaidPlan =
    billingData.hasActiveSubscription ||
    (workspacePlan?.planId !== "free" && workspacePlan?.status === "active");

  useEffect(() => {
    if (!isOpen) setFilterMenuOpen(false);
  }, [isOpen]);

  const closeNativeDrawer = useCallback(() => {
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!isNativeDrawer || !isOpen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeNativeDrawer();
      return true;
    });
    return () => sub.remove();
  }, [closeNativeDrawer, isNativeDrawer, isOpen]);

  const toggleCollapse = useCallback(() => {
    if (isNativeDrawer) {
      closeNativeDrawer();
      return;
    }
    setCollapsed((c) => !c);
  }, [closeNativeDrawer, isNativeDrawer]);

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      trackEvent(posthog, EVENTS.WORKSPACE_SWITCHED);
      setSelectedWorkspaceId(workspaceId);
      scheduleWorkspaceSwitch(workspaceId, projects);
    },
    [projects, posthog],
  );

  const handleCreateWorkspace = useCallback(() => {
    if (allWorkspaces.length >= 1) {
      router.push("/(app)/new-workspace" as any);
      if (!isWide) closeNativeDrawer();
    } else {
      setCreateWorkspaceOpen(true);
      if (!isWide) closeNativeDrawer();
    }
  }, [allWorkspaces.length, closeNativeDrawer, router, isWide]);

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (!user?.id) return;
      try {
        const newWorkspace = await actions.createWorkspace(
          name,
          undefined,
          user.id,
        );
        if (newWorkspace?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED);
          setSelectedWorkspaceId(newWorkspace.id);
          setActiveWorkspaceId(newWorkspace.id);
          await workspaces.loadAll();
          projects.clear();
          await projects.loadAll({ workspaceId: newWorkspace.id });
        }
      } catch (e) {
        console.warn("Failed to create workspace:", e);
      }
    },
    [actions, user?.id, workspaces, projects, posthog],
  );

  const handleSignOut = useCallback(async () => {
    trackEvent(posthog, EVENTS.SIGN_OUT);
    try {
      await signOut();
    } catch {}
  }, [signOut, posthog]);

  const onNavPress = useCallback(() => {
    if (!isWide) onClose?.();
  }, [isWide, onClose]);

  const prevPathnameRef = useRef(pathname);
  useEffect(() => {
    if (prevPathnameRef.current === pathname) return;
    prevPathnameRef.current = pathname;
    if (isOpen && isNativeDrawer) onClose?.();
  }, [isNativeDrawer, isOpen, onClose, pathname]);

  const handleSearchPress = useCallback(() => {
    if (isNativeDrawer) {
      router.push("/(app)/search" as any);
      onNavPress();
      return;
    }
    setCommandPaletteOpen(true);
  }, [isNativeDrawer, onNavPress, router, setCommandPaletteOpen]);

  const isHomePage =
    pathname === "/" || pathname === "/(app)" || pathname === "/(app)/index";
  const isMeetingsPage =
    pathname.startsWith("/meetings") || pathname.startsWith("/(app)/meetings");
  const isMarketplacePage =
    pathname.startsWith("/marketplace") ||
    pathname.startsWith("/(app)/marketplace");

  const sidebarContent = (
    <View
      role="navigation"
      accessibilityLabel="App sidebar"
      className={cn(
        "flex-1",
        isNativeDrawer ? undefined : "bg-card border-r border-border",
        collapsed ? "w-16" : isNativeDrawer ? "w-full" : "w-64",
      )}
      style={
        isNativeDrawer
          ? {
              paddingLeft: drawerSideInset,
              paddingRight: 4,
              backgroundColor: nativeDrawerCanvas,
            }
          : undefined
      }
    >
      {isNativeDrawer && <View style={{ height: drawerTopInset }} />}
      {/* ── Logo Row ── */}
      <View
        className={cn(
          "flex-row items-center",
          !isNativeDrawer && "border-b border-border",
          isNativeDrawer ? "h-16" : "h-12",
          collapsed ? "justify-center px-2" : "justify-between px-3",
        )}
      >
        {!collapsed && (
          <>
            <Pressable
              onPress={() => {
                router.push("/(app)" as any);
                onNavPress();
              }}
              role="link"
              accessibilityLabel="Shogo Home"
              className="flex-row items-center"
            >
              <ShogoWordmark
                className={
                  isNativeDrawer ? "h-8 w-[136px]" : "h-[22px] w-[94px]"
                }
              />
            </Pressable>
            {isNativeDrawer ? (
              <Pressable
                onPress={handleSearchPress}
                accessibilityLabel="Search"
                className={cn(
                  "rounded-md active:bg-muted",
                  drawerDensity.hit,
                )}
              >
                <Search
                  size={drawerDensity.icon.lg}
                  color={iconChrome.color}
                  strokeWidth={iconChrome.strokeWidth}
                />
              </Pressable>
            ) : (
              <Pressable
                onPress={toggleCollapse}
                className="h-8 w-8 items-center justify-center rounded-md active:bg-muted"
              >
                <PanelLeftClose size={12} className="text-muted-foreground" />
              </Pressable>
            )}
          </>
        )}
        {collapsed && (
          <Pressable
            onPress={toggleCollapse}
            accessibilityLabel="Expand sidebar"
          >
            <ShogoWordmark compact className="h-7 w-7" />
          </Pressable>
        )}
      </View>

      {/* ── Remote instance indicator ── */}
      {activeRemoteInstance && !collapsed && (
        <View className="px-3 py-1.5 bg-primary/10 border-b border-primary/20">
          <View className="flex-row items-center gap-2">
            <Laptop size={isNativeDrawer ? drawerDensity.icon.xs : 12} className="text-primary" />
            <Text
              className={cn(
                drawerDensity.text.caption,
                "text-primary font-medium flex-1",
              )}
              numberOfLines={1}
            >
              Controlling: {activeRemoteInstance.name}
            </Text>
          </View>
        </View>
      )}

      {/* ── Main Navigation (scrollable) ── */}
      <ScrollView
        className={cn("flex-1", isNativeDrawer ? "pt-3" : "pt-2")}
        showsVerticalScrollIndicator={false}
      >
        {/* Primary nav */}
        <View className="px-2">
          <NavItem
            icon={Home}
            label="Home"
            href="/(app)"
            active={isHomePage}
            collapsed={collapsed}
            onNavPress={onNavPress}
          />
          {features.marketplace && (
            <NavItem
              icon={Store}
              label="Marketplace"
              href="/(app)/marketplace"
              active={isMarketplacePage}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
          )}
          {!isNativeDrawer && (
            <NavItem
              icon={Search}
              label="Search"
              collapsed={collapsed}
              shortcut={formatModKey("k")}
              onPress={handleSearchPress}
            />
          )}
          {localMode && (
            <NavItem
              icon={Mic}
              label="Meetings"
              href="/(app)/meetings"
              active={isMeetingsPage}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
          )}
        </View>

        {/* PROJECTS tree — each project expands to show its chats */}
        <View className={cn("px-2", isNativeDrawer ? "mt-5" : "mt-4")}>
          {!collapsed && pinnedProjects.length > 0 && (
            <View className="mb-2">
              <Pressable
                onPress={() => setPinnedExpanded((expanded) => !expanded)}
                accessibilityLabel={
                  pinnedExpanded
                    ? "Collapse pinned projects"
                    : "Expand pinned projects"
                }
                accessibilityState={{ expanded: pinnedExpanded }}
                className={cn(
                  "flex-row items-center rounded-md px-1 active:bg-accent/50",
                  isNativeDrawer
                    ? `${drawerDensity.rowMin} gap-2.5 py-2`
                    : "gap-1.5 py-1",
                )}
              >
                <Text
                  className={cn(
                    "flex-1 font-semibold uppercase tracking-wider text-muted-foreground",
                    drawerDensity.text.label,
                  )}
                >
                  Pinned
                </Text>
                <SectionDisclosureChevron
                  expanded={pinnedExpanded}
                  size={sectionChevronSize}
                />
              </Pressable>
              {pinnedExpanded &&
                pinnedProjects.map((project: any) => (
                  <ProjectTreeItem
                    key={project.id}
                    project={project}
                    collapsed={collapsed}
                    onNavPress={onNavPress}
                    isPinned
                    onTogglePin={handleToggleProjectPin}
                    mobileProjectFirstTapShowsChats={isNativeDrawer}
                  />
                ))}
            </View>
          )}
          {!collapsed &&
            (unpinnedProjects.length > 0 || pinnedProjects.length === 0) && (
              <View
                className={cn(
                  "flex-row items-center gap-1 px-1",
                  isNativeDrawer ? "pb-2" : "pb-1",
                )}
              >
                <Pressable
                  onPress={toggleProjectsExpanded}
                  accessibilityLabel={
                    projectsExpanded ? "Collapse projects" : "Expand projects"
                  }
                  accessibilityState={{ expanded: projectsExpanded }}
                  className={cn(
                    "min-w-0 flex-1 flex-row items-center rounded-md active:bg-accent/50",
                    isNativeDrawer ? `${drawerDensity.rowMin} py-2` : "py-1",
                  )}
                >
                  <Text
                    className={cn(
                      "flex-1 font-semibold uppercase tracking-wider text-muted-foreground",
                      drawerDensity.text.label,
                    )}
                  >
                    Projects
                  </Text>
                </Pressable>
              {Platform.OS === "web" ? (
                <Popover
                  placement="bottom right"
                  size="sm"
                  isOpen={filterMenuOpen}
                  onOpen={() => setFilterMenuOpen(true)}
                  onClose={() => setFilterMenuOpen(false)}
                  trigger={(triggerProps) => (
                    <Pressable
                      {...triggerProps}
                      role="button"
                      accessibilityLabel="Filter and sort projects"
                      accessibilityState={{ expanded: filterMenuOpen }}
                      className="h-6 w-6 items-center justify-center rounded-md active:bg-muted"
                    >
                      <SlidersHorizontal
                        size={13}
                        className="text-muted-foreground"
                      />
                    </Pressable>
                  )}
                >
                  <PopoverBackdrop />
                  <PopoverContent className="w-[200px] p-0">
                    <PopoverBody>
                      <View className="py-1">
                        <Text
                          className={cn(
                            "px-3 pt-2 pb-1",
                            drawerDensity.text.caption,
                            "font-semibold uppercase tracking-wider text-muted-foreground",
                          )}
                        >
                          Sort by
                        </Text>
                        {PROJECT_SORT_OPTIONS.map((opt) => (
                          <Pressable
                            key={opt.value}
                            onPress={() =>
                              updateProjectFilter({ sort: opt.value })
                            }
                            role={MENU_ITEM_RADIO_ROLE}
                            accessibilityState={{
                              checked: projectFilter.sort === opt.value,
                            }}
                            className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                          >
                            <Text
                              className={cn(
                                "text-sm flex-1",
                                projectFilter.sort === opt.value
                                  ? "text-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              {opt.label}
                            </Text>
                            {projectFilter.sort === opt.value && (
                              <Check size={14} className="text-primary" />
                            )}
                          </Pressable>
                        ))}
                        <View className="h-px bg-border my-1" />
                        <Text
                          className={cn(
                            "px-3 pt-1 pb-1",
                            drawerDensity.text.caption,
                            "font-semibold uppercase tracking-wider text-muted-foreground",
                          )}
                        >
                          Show
                        </Text>
                        {PROJECT_SCOPE_OPTIONS.map((opt) => (
                          <Pressable
                            key={opt.value}
                            onPress={() =>
                              updateProjectFilter({ scope: opt.value })
                            }
                            role={MENU_ITEM_RADIO_ROLE}
                            accessibilityState={{
                              checked: projectFilter.scope === opt.value,
                            }}
                            className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
                          >
                            <Text
                              className={cn(
                                "text-sm flex-1",
                                projectFilter.scope === opt.value
                                  ? "text-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              {opt.label}
                            </Text>
                            {projectFilter.scope === opt.value && (
                              <Check size={14} className="text-primary" />
                            )}
                          </Pressable>
                        ))}
                      </View>
                    </PopoverBody>
                  </PopoverContent>
                </Popover>
              ) : null}
                <Pressable
                  onPress={toggleProjectsExpanded}
                  accessible={false}
                  hitSlop={8}
                  className={cn(
                    "shrink-0 items-center justify-center rounded-md active:bg-accent/50",
                    isNativeDrawer ? "h-8 w-8" : "p-1",
                  )}
                >
                  <SectionDisclosureChevron
                    expanded={projectsExpanded}
                    size={sectionChevronSize}
                  />
                </Pressable>
              </View>
            )}
          {projectsExpanded &&
            (workspaceProjects.length === 0 ? (
              !collapsed && (
                <View className="px-2 py-2">
                  <Text
                    className={cn(
                      "text-muted-foreground",
                      isNativeDrawer ? drawerDensity.text.body : "text-xs",
                    )}
                  >
                  {listFilter.scope === "mine"
                    ? "No projects you created"
                    : "No projects yet"}
                  </Text>
                </View>
              )
            ) : (
              <>
                {visibleUnpinnedProjects.map((project: any) => (
                  <ProjectTreeItem
                    key={project.id}
                    project={project}
                    collapsed={collapsed}
                    onNavPress={onNavPress}
                    isPinned={pinnedProjectIds.has(project.id)}
                    onTogglePin={handleToggleProjectPin}
                    mobileProjectFirstTapShowsChats={isNativeDrawer}
                  />
                ))}
                {!collapsed &&
                  unpinnedProjects.length > MAX_VISIBLE_PROJECTS &&
                  (hiddenProjectCount > 0 || showAllProjects) && (
                    <Pressable
                      onPress={() => setShowAllProjects((v) => !v)}
                      accessibilityLabel={
                        showAllProjects
                          ? "Show fewer projects"
                          : "Show all projects"
                      }
                      className={cn(
                        "flex-row items-center rounded-md px-2 active:bg-accent/50",
                        isNativeDrawer
                          ? `${drawerDensity.rowMin} gap-2.5 py-2`
                          : "gap-1.5 py-1.5",
                      )}
                    >
                      <SectionDisclosureChevron
                        expanded={showAllProjects}
                        size={sectionChevronSize}
                      />
                      <Text
                        className={cn(
                          "text-muted-foreground flex-1",
                          drawerDensity.text.body,
                        )}
                      >
                        {showAllProjects
                          ? "Show less"
                          : `${hiddenProjectCount} more`}
                      </Text>
                    </Pressable>
                  )}
              </>
            ))}
        </View>
      </ScrollView>

      {/* ── Bottom Section ── */}
      <View
        className={isNativeDrawer ? undefined : "border-t border-border"}
        style={{ paddingBottom: drawerFooterInset }}
      >
        {/* Upgrade to Pro CTA */}
        {features.billing && !collapsed && !isPaidPlan && (
          <View className={cn("px-2", isNativeDrawer ? "pt-3" : "pt-2")}>
            <Pressable
              onPress={() => {
                router.push("/(app)/billing" as any);
                onNavPress();
              }}
              className={cn(
                "flex-row items-center rounded-md",
                isNativeDrawer
                  ? "min-h-[72px] gap-3 px-4 py-3"
                  : "gap-2 px-3 py-2",
              )}
              style={
                Platform.OS === "web"
                  ? ({
                      backgroundImage:
                        "linear-gradient(to right, rgba(59,130,246,0.1), rgba(168,85,247,0.1))",
                    } as any)
                  : { backgroundColor: "rgba(59,130,246,0.1)" }
              }
            >
              <View className="flex-1">
                <Text
                  className={cn(
                    "font-medium text-foreground",
                    drawerDensity.text.body,
                  )}
                >
                  Upgrade to Pro
                </Text>
                <Text
                  className={cn(
                    "text-muted-foreground",
                    drawerDensity.text.label,
                  )}
                >
                  Unlock more benefits
                </Text>
              </View>
              <Plus
                size={isNativeDrawer ? drawerDensity.icon.lg : 16}
                className="text-primary"
              />
            </Pressable>
          </View>
        )}

        {/* Consolidated workspace + user row */}
        <View
          className={cn(
            "flex-row items-center border-t border-border",
            isNativeDrawer ? "min-h-16 gap-2.5 px-3 pt-2 pb-1" : "gap-2 p-2",
            collapsed ? "justify-center" : "px-3",
          )}
        >
          <View className={cn("min-w-0", !collapsed && "flex-1")}>
            <AccountMenu
              user={user}
              onSignOut={handleSignOut}
              onNavigate={(href) => {
                router.push(href as any);
                onNavPress();
              }}
              isSuperAdmin={hasAdminAccess}
              isWide={isWide}
              collapsed={collapsed}
              workspaces={allWorkspaces}
              currentWorkspace={currentWorkspace}
              billingData={billingData}
              workspacePlan={workspacePlan}
              allPlans={allPlans}
              showBilling={features.billing}
              onSwitchWorkspace={handleSwitchWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              localMode={localMode}
            />
          </View>

          {!collapsed && (
            <NotificationBell
              size={isNativeDrawer ? drawerDensity.icon.lg : 18}
              onPress={onNavPress}
            />
          )}

          {!collapsed && (
            <Pressable
              onPress={() => setInboxOpen(true)}
              className={cn(
                "relative shrink-0 rounded-md active:bg-muted",
                isNativeDrawer ? drawerDensity.hit : "p-1.5",
              )}
            >
              <Inbox
                size={isNativeDrawer ? drawerDensity.icon.lg : 18}
                color={isNativeDrawer ? iconChrome.color : undefined}
                strokeWidth={
                  isNativeDrawer ? iconChrome.strokeWidth : undefined
                }
                className={isNativeDrawer ? undefined : "text-muted-foreground"}
              />
              {pendingInvites.length > 0 && (
                <View className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive items-center justify-center">
                  <Text className="text-[9px] font-bold text-white">
                    {pendingInvites.length}
                  </Text>
                </View>
              )}
            </Pressable>
          )}
        </View>
      </View>

      <InboxPanel
        visible={inboxOpen}
        isWide={isWide}
        pendingInvites={pendingInvites}
        processingInvite={processingInvite}
        onClose={() => setInboxOpen(false)}
        onAccept={acceptInvite}
        onDecline={declineInvite}
      />

      {/* Modals (true dialogs that are fine as centered overlays) */}
      <CreateWorkspaceModal
        visible={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onSubmit={handleCreateWorkspaceSubmit}
      />
      <CommandPalette
        visible={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </View>
  );

  if (isWide) {
    return <View className="h-full">{sidebarContent}</View>;
  }

  if (isNativeDrawer) {
    return (
      <View style={{ flex: 1, backgroundColor: nativeDrawerCanvas }}>
        {sidebarContent}
      </View>
    );
  }

  if (!isOpen) return null;

  return (
    <View
      className="absolute left-0 right-0 z-50 flex-row"
      style={{ top: 0, bottom: 0, paddingTop: insets.top }}
    >
      <Pressable onPress={onClose} className="absolute inset-0 bg-black/50" />
      <View className="w-72 h-full z-10">{sidebarContent}</View>
    </View>
  );
});
