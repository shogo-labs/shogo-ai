// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * (app) layout - Responsive app shell
 *
 * Wide screens (>= 768px): persistent sidebar + content side by side
 * Narrow screens (< 768px):
 *  - Native: hamburger + two-layer sheet drawer (sidebar under the moving screen)
 *  - Web: header with hamburger + overlay sidebar
 *
 * Route-aware visibility:
 *  - Home page (wide): sidebar visible, NO header
 *  - List pages (wide): sidebar visible, NO header (sidebar provides nav)
 *  - Project detail (wide): workspace rail and conversation sidebar frame
 *    the project's own dense editor/IDE surface
 *  - Billing page (wide): NO sidebar (standalone full-width page)
 *  - All pages (narrow): hamburger header + drawer sidebar
 *
 * Auth guard redirects unauthenticated users to sign-in (or root in local mode).
 */

import { useState, useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Slot, Stack, usePathname, useRouter } from "expo-router";
import { useAuth } from "../../contexts/auth";
import {
  isWorkspaceRuntimeEnabled,
  usePlatformConfig,
} from "../../lib/platform-config";
import { api, API_URL, createHttpClient } from "../../lib/api";
import {
  discardPendingSignupAttribution,
  flushSignupAttribution,
  getPendingSignupAttribution,
  shouldRecordSignupAttribution,
} from "../../lib/attribution";
import { trackSignUp, trackLogin } from "../../lib/tracking";
import { usePostHogIdentify, usePostHogSafe } from "../../contexts/posthog";
import { DomainProvider, useWorkspaceCollection } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useActiveInstance } from "../../contexts/active-instance";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import {
  homePathForWorkspaceKind,
  subscribeWorkspaceSwitched,
} from "../../lib/switch-workspace";
import { useResolvedTheme } from "../../contexts/theme";
import { AppSidebar } from "../../components/layout/AppSidebar";
import { TeamChatNotifier } from "../../components/team-chat/TeamChatNotifier";
import { NotificationPermissionBanner } from "../../components/notifications/NotificationPermissionBanner";
import { AgentLimitBanner } from "../../components/AgentLimitBanner";
import { AgentGlancePublisher } from "../../components/layout/AgentGlancePublisher";
import { HuddleWindow } from "../../components/team-chat/HuddleWindow";
import { HuddleRinger } from "../../components/team-chat/HuddleRinger";
import { AppHeader } from "../../components/layout/AppHeader";
import { RecordingIndicator } from "../../components/meetings/RecordingIndicator";
import { NativeRecorderProvider } from "../../lib/native-recorder";
import { useNotificationClickRouter } from "../../lib/notifications/useNotificationClickRouter";
import { useDesktopIslandRouter } from "../../lib/useDesktopIslandRouter";
import { useMobilePushRegistration } from "../../lib/notifications/mobile-push-registration";
import { useAppInstallHeartbeat } from "../../lib/app-install-heartbeat";
import { useNotifyOnTurnComplete } from "../../lib/notifications/preferences";
import { mark as csMark } from "../../lib/cold-start-timing";
import {
  nativePhoneCanvas,
  NATIVE_PHONE_HOME_CANVAS,
  usePhoneLayout,
  WEB_WIDE_MIN_WIDTH,
} from "../../lib/native-phone-layout";
import { useNativeSheetDrawer } from "../../lib/use-native-drawer-swipe";
import { useNativePhoneSheetOpen } from "../../lib/native-phone-sheet-lock";
import { NativeSheetDrawerShell } from "../../components/layout/NativeSheetDrawerShell";
import { MobileBottomNav } from "../../components/layout/MobileBottomNav";
import { TeamChatSidebarProvider } from "../../components/team-chat/TeamChatSidebarProvider";
import { MobileWorkspaceShell } from "../../components/layout/MobileWorkspaceShell";
import { sidebarOpenEvents } from "../../lib/sidebar-open-events";
import { getCloudWorkspacesState, refreshCloudWorkspaces, subscribeCloudWorkspaces } from "../../lib/workspace-route";
import { isConversationPath } from "../../lib/sidebar-tab";

csMark("app:layout:module-load");

/**
 * Phone stack screens draw their own header. Each paints the canvas colour
 * itself: transparent screens let the one underneath show through while a
 * cross-fade or slide is mid-flight, so a quick burst of taps stacks ghosted
 * pages on top of each other.
 */
const PHONE_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "slide_from_right",
} as const;

/**
 * What the More tab lists. The dock stays up under them, so they cross-fade like
 * a tab, and their edge swipe is off: dragging one aside dims the page but not
 * the dock's strip, leaving a white band along the bottom.
 */
const PHONE_MORE_DESTINATIONS_LIST = [
  "analytics",
  "work",
  "social",
  "marketplace",
  "creator",
  "starred",
  "shared",
];

/**
 * Screens the bottom nav switches between. The nav bar is a persistent layer
 * outside the stack, so sliding a whole page in dims and moves everything
 * except the strip the nav sits on, leaving a white band along the bottom for
 * the length of the transition. Peer destinations cross-fade instead, as a tab
 * bar does; real drill-downs keep the slide.
 */
const PHONE_TAB_ROUTES = new Set([
  // The Chat tab lands on the app index; inside a project, the Chat / Canvas /
  // Files / Plans tabs switch between these two.
  "index",
  "project-chat",
  "project-surface",
  "agent",
  "meetings",
  "goals",
  "activity",
  "tasks",
  "canvases",
  // The team dock's tabs.
  "home",
  "more",
  ...PHONE_MORE_DESTINATIONS_LIST,
]);

/**
 * Full route names that cross-fade although their first segment also holds
 * real drill-downs: the DMs tab, and a conversation, which is full-bleed with
 * the dock drawn over it (sliding it leaves a white band where the dock is).
 */
const PHONE_TAB_SCREENS = new Set(["c/dms", "c/[conversationId]"]);

const PHONE_TAB_FADE_MS = 140;

/**
 * Phone screens that bring their own header (a large title, or a title with a
 * back arrow), so they skip the shared hamburger header and its sidebar drawer.
 */
const PHONE_OWN_CHROME_ROUTES = new Set([
  "analytics",
  "work",
  "social",
  "marketplace",
  "creator",
  "starred",
  "shared",
  "affiliate",
  "huddles",
  "new-workspace",
  "f",
]);

/**
 * The edge swipe pops the stack, and these screens are peers the dock switches
 * between rather than drill-downs, so it would reveal whichever tab came before
 * and snap back. Workspace chat also owns a finger-following sessions drawer on
 * a right swipe, so one swipe would do two things. Home stays a tap away on the
 * dock. Everything in `PHONE_TAB_ROUTES` has it off, plus the DMs tab (the rest
 * of `c/` are conversations you drill into).
 */
const PHONE_NO_BACK_SWIPE_SCREENS = new Set(["c/dms"]);

const phoneStackScreenOptions = (canvas: string) => ({ route }: { route: { name: string } }) => ({
  ...PHONE_STACK_SCREEN_OPTIONS,
  contentStyle: { backgroundColor: canvas },
  // Only read for `fade`: a short dissolve, so a quick run of tab taps never
  // sits on two half-visible pages.
  animationDuration: PHONE_TAB_FADE_MS,
  gestureEnabled:
    !PHONE_NO_BACK_SWIPE_SCREENS.has(route.name) &&
    !PHONE_TAB_ROUTES.has(route.name.split("/")[0]),
  animation:
    // On a phone `/settings` only redirects to `/account`. Sliding it in would
    // show an empty page before the redirect lands, so it appears instantly
    // and `/account` does the sliding.
    route.name === "settings"
      ? ("none" as const)
      : PHONE_TAB_SCREENS.has(route.name) || PHONE_TAB_ROUTES.has(route.name.split("/")[0])
        ? ("fade" as const)
        : PHONE_STACK_SCREEN_OPTIONS.animation,
});

function AppLayoutInner() {
  csMark("app:layout:render");
  const { isAuthenticated, isLoading, user, refreshSession } = useAuth();
  const { localMode } = usePlatformConfig();
  // The compact workspace agent chrome is mobile-only. Wide web keeps the
  // established AppSidebar while the personal workspace can still render its
  // agent chat content with desktop presentation. `useWorkspaceExperience()`
  // defaults to `'team'` until the active workspace has loaded, so narrow
  // surfaces avoid flashing the new mobile chrome before their workspace is
  // known.
  const experience = useWorkspaceExperience();
  const activeWorkspace = useActiveWorkspace();
  const { instance } = useActiveInstance();
  const workspaces = useWorkspaceCollection();
  const router = useRouter();
  const pathname = usePathname();
  const isIdeEmbed = useMemo(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("embed") === "ide";
  }, []);
  const ideApiBaseUrl = useMemo(() => {
    if (isIdeEmbed && Platform.OS === "web" && typeof window !== "undefined") {
      return window.location.origin;
    }
    return API_URL;
  }, [isIdeEmbed]);
  const [ideAutoSigningIn, setIdeAutoSigningIn] = useState(false);
  const [ideAutoSignInError, setIdeAutoSignInError] = useState<string | null>(
    null
  );
  const ideAutoSignInAttempted = useRef(false);
  const { width } = useWindowDimensions();
  const isNativeApp = Platform.OS !== "web";
  const isDark = useResolvedTheme() === "dark";
  const isPhone = usePhoneLayout();
  const phoneSheetOpen = useNativePhoneSheetOpen();
  const nativeDrawerCanvas = nativePhoneCanvas(isDark);
  const stackScreenOptions = useMemo(
    () => phoneStackScreenOptions(nativeDrawerCanvas),
    [nativeDrawerCanvas],
  );
  const isWide = !isNativeApp && width >= WEB_WIDE_MIN_WIDTH;
  // Phones get a real navigator so a screen you go into is pushed over Home and
  // back pops it; desktop and wide web (and tablets) keep the flat Slot.
  const phoneStack = !isWide && !isIdeEmbed && isPhone;
  const isProjectDetail =
    /^\/(app\/)?projects\/[^/]+/.test(pathname.replace(/^\/(app\/)?/, "/")) &&
    pathname !== "/projects" &&
    pathname !== "/(app)/projects";
  // The mobile shell is coupled to the workspace runtime: without it, the
  // legacy home remains available instead of exposing a chat that cannot run
  // turns. All workspace kinds share this mobile chrome; wide web keeps the
  // AppSidebar and uses the workspace-specific content presentation.
  const mobileAgentShellEnabled = isWorkspaceRuntimeEnabled();
  const isHomePage =
    pathname === "/" || pathname === "/(app)" || pathname === "/(app)/index";
  // `/(app)/home` is the pre-landing home: the team feed on a phone and the
  // builder on wide web. `/` itself is the workspace agent chat.
  const isExplicitHome = pathname === "/home" || pathname === "/(app)/home";
  const isHomeCanvas = (isHomePage || isExplicitHome) && isDark;
  // The workspace agent chat has a route of its own (`/agent`); on phones the
  // team Home feed lives on `/(app)/home` and links into it.
  const isAgentChatPage = /\/agent\/?$/.test(pathname);
  const isTeamHomeFeed =
    isExplicitHome &&
    !isWide &&
    !isIdeEmbed &&
    mobileAgentShellEnabled &&
    (experience.kind === "team" || !experience.resolved);
  const isWorkspaceChatRoute =
    isHomePage ||
    isExplicitHome ||
    isAgentChatPage ||
    isProjectDetail ||
    pathname.includes("/new-project") ||
    pathname.includes("/side-chats/") ||
    pathname.includes("/project-chat/") ||
    pathname.includes("/project-surface/");
  const useMobileWorkspaceShell =
    !isWide &&
    !isIdeEmbed &&
    mobileAgentShellEnabled &&
    isWorkspaceChatRoute &&
    !isTeamHomeFeed;
  const phoneShellMounted = !isWide && !isIdeEmbed && mobileAgentShellEnabled;
  // Team phone tab screens draw their own large title and avatar.
  const isTeamTabScreen =
    !isWide &&
    !isIdeEmbed &&
    experience.kind === "team" &&
    (isTeamHomeFeed ||
      /\/c\/dms\/?$/.test(pathname) ||
      /\/more\/?$/.test(pathname) ||
      /\/activity\/?$/.test(pathname));

  // Phone channel/DM screens are full-bleed: their own floating header, with
  // the dock drawn over the messages.
  const isFloatingConversation =
    !isWide && !isIdeEmbed && isConversationPath(pathname);

  // The phone "New message" / "Create channel" screen draws its own header and
  // sits full-screen: no app header, no dock, edge-to-edge.
  const isNewConversationPage =
    !isWide && !isIdeEmbed && /\/c\/new\/?$/.test(pathname);

  const isBillingPage =
    pathname === "/billing" || pathname === "/(app)/billing";
  // The notifications inbox provides its own header (back + mark-all-read), so
  // suppress the app header on narrow screens to avoid stacking two headers.
  const isNotificationsPage =
    pathname === "/notifications" || pathname === "/(app)/notifications";
  const isApiKeysPage =
    pathname === "/api-keys" || pathname === "/(app)/api-keys";
  const isProfilePage =
    pathname === "/profile" || pathname === "/(app)/profile";
  const isAccountPage =
    pathname === "/account" || pathname === "/(app)/account";
  // Phone Settings redirects to Account (`lib/phone-settings-route.ts`). The
  // redirect frame must not draw the legacy AppHeader or open the legacy
  // AppSidebar drawer — it is a phone screen, not the wide Settings page.
  const isSettingsPage =
    pathname === "/settings" || pathname === "/(app)/settings";
  const isSearchPage = pathname === "/search" || pathname === "/(app)/search";
  // "Search messages" and "Browse channels", opened from Home's lists, draw
  // their own phone header with a back arrow.
  const isTeamChatSubpage =
    !isWide && !isIdeEmbed && isPhone && /\/c(\/search)?\/?$/.test(pathname);
  const isProjectChatsPage =
    pathname === "/project-chats" || pathname === "/(app)/project-chats";
  const isAIModelsPage =
    pathname === "/ai-models" || pathname === "/(app)/ai-models";
  const isMeetingsPage = /\/meetings\/?$/.test(pathname);
  // These pad for the status bar themselves (TabScreen or safe-area insets), so
  // the shell must not add the inset a second time.
  const isSelfInsetPage = /\/(analytics|work|social)\/?$/.test(pathname);
  const isNonChatWorkspacePage = [
    "/tasks",
    "/activity",
    "/canvases",
    "/goals",
    "/meetings",
  ].some((segment) => pathname.includes(segment));
  // Screens that draw their own title or back arrow. Wrapping them in the
  // legacy hamburger header stacked two headers and opened the full AppSidebar,
  // a different left drawer from the rest of the phone app.
  const isOwnChromePage = PHONE_OWN_CHROME_ROUTES.has(
    pathname.split("/").filter((part) => part && part !== "(app)")[0] ?? "",
  );

  usePostHogIdentify();
  const posthog = usePostHogSafe();
  useNotificationClickRouter();
  useDesktopIslandRouter();
  const [notifyOnTurnComplete] = useNotifyOnTurnComplete();
  useMobilePushRegistration(user?.id ?? null, notifyOnTurnComplete);
  useAppInstallHeartbeat(user?.id ?? null);

  useEffect(() => {
    if (isAuthenticated && posthog) {
      posthog.screen(pathname);
    }
  }, [pathname, isAuthenticated, posthog]);

  useEffect(() => {
    if (
      !localMode ||
      isAuthenticated ||
      isLoading ||
      ideAutoSignInAttempted.current
    )
      return;
    ideAutoSignInAttempted.current = true;
    setIdeAutoSigningIn(true);
    setIdeAutoSignInError(null);
    fetch(`${ideApiBaseUrl}/api/local/auto-sign-in`, {
      method: "POST",
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return refreshSession();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[LocalMode] Auto-sign-in failed:", err);
        setIdeAutoSignInError(message || "auto sign-in failed");
      })
      .finally(() => setIdeAutoSigningIn(false));
  }, [
    ideApiBaseUrl,
    isAuthenticated,
    isIdeEmbed,
    isLoading,
    localMode,
    refreshSession,
  ]);

  // Local mode signs in above instead of redirecting: "/" also resolves to
  // (app)/index, so replacing to it from here re-renders this layout and
  // loops until React aborts with "Maximum update depth exceeded" on a cold
  // signed-out deep link. The latch covers the remaining fallback.
  const signedOutRedirected = useRef(false);
  useEffect(() => {
    if (isAuthenticated) {
      signedOutRedirected.current = false;
      return;
    }
    if (!isLoading && !ideAutoSigningIn) {
      if (localMode && (isIdeEmbed || !ideAutoSignInError)) return;
      if (signedOutRedirected.current) return;
      signedOutRedirected.current = true;
      router.replace(localMode ? "/" : "/(auth)/sign-in");
    }
  }, [
    isAuthenticated,
    isIdeEmbed,
    ideAutoSigningIn,
    ideAutoSignInError,
    isLoading,
    localMode,
    router,
  ]);

  useEffect(() => {
    if (!isLoading) csMark("app:layout:auth-resolved", { isAuthenticated });
  }, [isLoading, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !workspaces) return;
    workspaces.loadAll().catch((error: unknown) => {
      console.error("[AppLayout] Failed to load workspaces:", error);
    });
  }, [isAuthenticated, workspaces]);

  // Desktop signed in to Shogo Cloud: keep its cloud workspaces in the
  // switcher, re-checking on focus so newly joined ones appear, and reload
  // the list whenever sign-in or sign-out changes them.
  useEffect(() => {
    if (!localMode || !isAuthenticated || !workspaces) return;
    const idsOf = () => getCloudWorkspacesState().workspaces.map((w) => w.id).sort().join(",");
    let known = idsOf();
    const unsubscribe = subscribeCloudWorkspaces(() => {
      const ids = idsOf();
      if (ids !== known) workspaces.loadAll().catch(() => undefined);
      known = ids;
    });
    const refresh = (sync = false) => refreshCloudWorkspaces(API_URL!, { sync });
    void refresh();
    const timer = setInterval(() => void refresh(), 5 * 60_000);
    const onFocus = () => void refresh(true);
    // `window` exists on native but has no `addEventListener`.
    const hasWindowEvents = typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (hasWindowEvents) window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      clearInterval(timer);
      if (hasWindowEvents) window.removeEventListener("focus", onFocus);
    };
  }, [localMode, isAuthenticated, workspaces]);

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    try {
      const pending = sessionStorage.getItem("oauth_pending");
      if (pending) {
        sessionStorage.removeItem("oauth_pending");
        const accountAge = user.createdAt
          ? Date.now() - new Date(user.createdAt).getTime()
          : Infinity;
        if (accountAge < 60_000) {
          trackSignUp(pending as "google");
        } else {
          trackLogin(pending as "google");
        }
      }
    } catch {}

    const queued = getPendingSignupAttribution();
    if (!queued) return;
    if (!shouldRecordSignupAttribution(queued, user.createdAt)) {
      discardPendingSignupAttribution();
      return;
    }
    const http = createHttpClient();
    void flushSignupAttribution((body) => api.postSignupAttribution(http, body)).catch(
      () => {},
    );
  }, [isAuthenticated, user]);

  const suppressNarrowAppHeader =
    isProjectDetail ||
    isBillingPage ||
    isNotificationsPage ||
    isApiKeysPage ||
    isProfilePage ||
    isAccountPage ||
    isSettingsPage ||
    isSearchPage ||
    isProjectChatsPage ||
    isAIModelsPage ||
    isNonChatWorkspacePage ||
    isOwnChromePage ||
    isTeamTabScreen ||
    isNewConversationPage ||
    isTeamChatSubpage ||
    isFloatingConversation;
  // The companion mobile shell owns its own drawer and swipe gesture. Keep
  // the legacy sheet drawer inactive there so an edge swipe cannot reveal the
  // old AppSidebar behind the new chat chrome.
  const nativeDrawerSwipe =
    !isWide &&
    !isIdeEmbed &&
    !useMobileWorkspaceShell &&
    !phoneSheetOpen &&
    (!suppressNarrowAppHeader || isProjectDetail);
  const nativeSheetDrawer =
    !isWide && !isIdeEmbed && !useMobileWorkspaceShell;
  const drawer = useNativeSheetDrawer({
    windowWidth: width,
    isDark,
    swipeEnabled: nativeDrawerSwipe,
    closedCanvas: isHomeCanvas ? NATIVE_PHONE_HOME_CANVAS : undefined,
  });
  const { drawerOpen, closeDrawer, toggleDrawer, openDrawer, resetDrawer } =
    drawer;

  useEffect(() => {
    if (phoneSheetOpen && drawerOpen) closeDrawer();
  }, [closeDrawer, drawerOpen, phoneSheetOpen]);

  useEffect(() => {
    if (!isWide && !isAccountPage && !isSettingsPage) return;
    resetDrawer();
  }, [isAccountPage, isSettingsPage, isWide, resetDrawer]);

  // Home's workspace avatar is the sidebar's only button on a phone; the drawer
  // itself stays here, where the shell owns it.
  useEffect(() => {
    if (isWide || isIdeEmbed) return;
    return sidebarOpenEvents.subscribeOpenSidebar(() => openDrawer());
  }, [isIdeEmbed, isWide, openDrawer]);

  useEffect(() => {
    if (useMobileWorkspaceShell) resetDrawer();
  }, [resetDrawer, useMobileWorkspaceShell]);

  // After a workspace switch, leave the previous screen: every workspace
  // lands on its agent chat. `openInWorkspace` navigates itself and does not
  // emit this.
  useEffect(() => {
    return subscribeWorkspaceSwitched(() => {
      const href = homePathForWorkspaceKind();
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.location.assign(href.replace(/\/\([^)]+\)/g, "") || "/");
        return;
      }
      router.replace(href as any);
    });
  }, [router]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const d = (window as any).shogoDesktop;
    if (!d?.onNavigate) return;
    d.onNavigate((path: string) => {
      router.push(path as any);
    });
    return () => d.removeNavigateListener?.();
  }, [router]);

  if (isLoading || ideAutoSigningIn) {
    if (isIdeEmbed) {
      return (
        <View className="flex-1 items-center justify-center bg-background p-4">
          <ActivityIndicator size="large" />
          <Text className="mt-3 text-sm text-muted-foreground">
            Loading Shogo chat…
          </Text>
        </View>
      );
    }
    return null;
  }

  if (!isAuthenticated) {
    if (isIdeEmbed) {
      const retry = () => {
        ideAutoSignInAttempted.current = false;
        setIdeAutoSignInError(null);
        setIdeAutoSigningIn(true);
        fetch(`${ideApiBaseUrl}/api/local/auto-sign-in`, {
          method: "POST",
          credentials: "include",
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return refreshSession();
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[IDEEmbed] Auto-sign-in retry failed:", err);
            setIdeAutoSignInError(message || "auto sign-in failed");
          })
          .finally(() => setIdeAutoSigningIn(false));
      };
      return (
        <View className="flex-1 items-center justify-center bg-background p-4">
          <Text className="text-base font-semibold text-foreground">
            Shogo chat could not sign in
          </Text>
          <Text className="mt-2 max-w-md text-center text-sm text-muted-foreground">
            {ideAutoSignInError
              ? `Local sign-in failed: ${ideAutoSignInError}`
              : "Waiting for the Desktop local session…"}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="mt-4 rounded-md bg-primary px-4 py-2"
            onPress={retry}
          >
            <Text className="text-sm font-medium text-primary-foreground">
              Retry
            </Text>
          </Pressable>
        </View>
      );
    }
    return null;
  }

  const showSidebar = isWide && !isIdeEmbed && !isBillingPage;
  const nativeEdgeToEdgeChrome =
    isFloatingConversation ||
    isNewConversationPage ||
    (isNativeApp &&
      !isIdeEmbed &&
      (isHomePage ||
        isTeamTabScreen ||
        isSelfInsetPage ||
        isTeamChatSubpage ||
        isMeetingsPage ||
        isSearchPage ||
        isAccountPage ||
        isNotificationsPage ||
        // A project page's header pads for nothing itself (4pt), so the shell
        // has to keep it below the status bar.
        (useMobileWorkspaceShell && !isProjectDetail)));

  return (
    <TeamChatSidebarProvider
      workspaceId={
        experience.kind === "team"
          ? // A machine workspace's team chat lives on the machine: its own
            // workspace id, not the cloud workspace that happens to be selected
            // (SHO-185). Asking the cloud id resolved the chat mode of a
            // different workspace, so the machine's channels never appeared.
            (instance?.source === "machine" ? instance.localWorkspaceId : null) ?? activeWorkspace?.id ?? null
          : null
      }
    >
    <NativeSheetDrawerShell
      isWide={isWide}
      nativeSheetDrawer={nativeSheetDrawer}
      canvas={
        isHomeCanvas ? NATIVE_PHONE_HOME_CANVAS : nativeDrawerCanvas
      }
      safeAreaEdges={nativeEdgeToEdgeChrome ? ["left", "right"] : undefined}
      sidebarWide={showSidebar ? <AppSidebar /> : null}
      sidebarSheet={<AppSidebar isOpen={drawerOpen} onClose={closeDrawer} />}
      lazySidebarSheet={!isWide}
      sidebarOverlay={
        <AppSidebar
          isOpen={drawerOpen}
          onClose={closeDrawer}
          isNativeDrawer={false}
        />
      }
      header={
        !isWide &&
        !isIdeEmbed &&
        !suppressNarrowAppHeader &&
        !useMobileWorkspaceShell ? (
          <AppHeader onMenuPress={toggleDrawer} menuOpen={drawerOpen} />
        ) : null
      }
      bottomNav={
        !isWide && !isIdeEmbed && !isAIModelsPage ? (
          <MobileBottomNav key={activeWorkspace?.id ?? "workspace-loading"} />
        ) : null
      }
      overlayBottomNav={isFloatingConversation}
      drawer={drawer}
    >
      {(localMode || Platform.OS !== "web") && !isIdeEmbed ? <RecordingIndicator /> : null}
      {!isIdeEmbed ? <TeamChatNotifier /> : null}
      {!isIdeEmbed ? <NotificationPermissionBanner /> : null}
      {!isIdeEmbed ? <AgentLimitBanner /> : null}
      {!isIdeEmbed ? <AgentGlancePublisher /> : null}
      {!isIdeEmbed ? <HuddleWindow /> : null}
      {!isIdeEmbed ? <HuddleRinger /> : null}
      {/* The shell stays mounted on every phone route and only toggles its
          chrome. Swapping the parent of the navigator between routes (e.g. the
          team Home feed -> a project) remounts it mid-push and the tap appears
          to do nothing. On a phone the navigator is a real Stack, so a screen
          you go into is pushed over Home and back pops it without rebuilding
          Home; desktop and wide web keep the flat Slot. */}
      {phoneShellMounted ? (
        <MobileWorkspaceShell
          key={activeWorkspace?.id ?? "workspace-loading"}
          enabled={useMobileWorkspaceShell}
        >
          {phoneStack ? <Stack screenOptions={stackScreenOptions} /> : <Slot />}
        </MobileWorkspaceShell>
      ) : phoneStack ? (
        <Stack screenOptions={stackScreenOptions} />
      ) : (
        <Slot />
      )}
    </NativeSheetDrawerShell>
    </TeamChatSidebarProvider>
  );
}

/**
 * `AppLayoutInner` needs `useWorkspaceExperience()` (workspace kind) to
 * decide personal-vs-team chrome, which requires the domain store context.
 * Mount `DomainProvider` here, one level up, rather than inside
 * `AppLayoutInner` itself — matching `(admin)/_layout.tsx`'s split.
 */
export default function AppLayout() {
  return (
    <DomainProvider>
      <NativeRecorderProvider>
        <AppLayoutInner />
      </NativeRecorderProvider>
    </DomainProvider>
  );
}
