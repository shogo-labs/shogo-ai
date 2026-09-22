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
import { Slot, usePathname, useRouter } from "expo-router";
import { useAuth } from "../../contexts/auth";
import {
  isWorkspaceRuntimeEnabled,
  usePlatformConfig,
} from "../../lib/platform-config";
import { API_URL } from "../../lib/api";
import { trackSignUp, trackLogin } from "../../lib/tracking";
import { usePostHogIdentify, usePostHogSafe } from "../../contexts/posthog";
import { DomainProvider } from "../../contexts/domain";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { useResolvedTheme } from "../../contexts/theme";
import { AppSidebar } from "../../components/layout/AppSidebar";
import { AppHeader } from "../../components/layout/AppHeader";
import { RecordingIndicator } from "../../components/meetings/RecordingIndicator";
import { useNotificationClickRouter } from "../../lib/notifications/useNotificationClickRouter";
import { useMobilePushRegistration } from "../../lib/notifications/mobile-push-registration";
import { useNotifyOnTurnComplete } from "../../lib/notifications/preferences";
import { mark as csMark } from "../../lib/cold-start-timing";
import {
  nativePhoneCanvas,
  NATIVE_PHONE_HOME_CANVAS,
  WEB_WIDE_MIN_WIDTH,
} from "../../lib/native-phone-layout";
import { useNativeSheetDrawer } from "../../lib/use-native-drawer-swipe";
import { useNativePhoneSheetOpen } from "../../lib/native-phone-sheet-lock";
import { NativeSheetDrawerShell } from "../../components/layout/NativeSheetDrawerShell";
import { MobileBottomNav } from "../../components/layout/MobileBottomNav";
import { WorkspaceAgentShell } from "../../components/layout/WorkspaceAgentShell";
import { MobileWorkspaceShell } from "../../components/layout/MobileWorkspaceShell";
import { projectSidebarEvents } from "../../lib/project-sidebar-events";

csMark("app:layout:module-load");

function AppLayoutInner() {
  csMark("app:layout:render");
  const { isAuthenticated, isLoading, user, refreshSession } = useAuth();
  const { localMode, features } = usePlatformConfig();
  // The workspace agent shell (new sidebar + WorkspaceAgentShell/
  // MobileWorkspaceShell chrome) is personal-workspace-only — team
  // workspaces always keep the classic AppSidebar + plain project view,
  // on both web and local desktop. `useWorkspaceExperience()` defaults to
  // `'team'` until the active workspace has loaded, which is the correct
  // fail-safe here too (never flash the new shell before we know better).
  const experience = useWorkspaceExperience();
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
  const phoneSheetOpen = useNativePhoneSheetOpen();
  const nativeDrawerCanvas = nativePhoneCanvas(isDark);
  const isWide = !isNativeApp && width >= WEB_WIDE_MIN_WIDTH;
  const isProjectDetail =
    /^\/(app\/)?projects\/[^/]+/.test(pathname.replace(/^\/(app\/)?/, "/")) &&
    pathname !== "/projects" &&
    pathname !== "/(app)/projects";
  // The shell is coupled to the workspace runtime: without it, the legacy
  // home remains available instead of exposing a chat that cannot run turns.
  // Desktop and narrow/native rollouts are deliberately independent. Gated
  // to personal workspaces only — see `experience` above.
  const isPersonalWorkspace = experience.kind === "personal";
  const desktopAgentShellEnabled =
    isWorkspaceRuntimeEnabled() &&
    isPersonalWorkspace &&
    (localMode || features.agentShell);
  const mobileAgentShellEnabled =
    isWorkspaceRuntimeEnabled() &&
    isPersonalWorkspace &&
    (localMode || features.mobileAgentShell);
  const useAgentShell = isWide && !isIdeEmbed && desktopAgentShellEnabled;
  const isHomePage =
    pathname === "/" || pathname === "/(app)" || pathname === "/(app)/index";
  const isWorkspaceChatRoute =
    isHomePage ||
    isProjectDetail ||
    pathname.includes("/side-chats/") ||
    pathname.includes("/project-chat/") ||
    pathname.includes("/project-surface/");
  const useMobileWorkspaceShell =
    !isWide && !isIdeEmbed && mobileAgentShellEnabled && isWorkspaceChatRoute;

  const isSettingsPage =
    pathname === "/settings" ||
    pathname === "/(app)/settings" ||
    pathname.includes("/settings");
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
  const isSearchPage = pathname === "/search" || pathname === "/(app)/search";
  const isProjectChatsPage =
    pathname === "/project-chats" || pathname === "/(app)/project-chats";

  usePostHogIdentify();
  const posthog = usePostHogSafe();
  useNotificationClickRouter();
  const [notifyOnTurnComplete] = useNotifyOnTurnComplete();
  useMobilePushRegistration(user?.id ?? null, notifyOnTurnComplete);

  useEffect(() => {
    if (isAuthenticated && posthog) {
      posthog.screen(pathname);
    }
  }, [pathname, isAuthenticated, posthog]);

  useEffect(() => {
    if (
      !localMode ||
      !isIdeEmbed ||
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
        console.error("[IDEEmbed] Auto-sign-in failed:", err);
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

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !ideAutoSigningIn) {
      if (localMode && isIdeEmbed) return;
      router.replace(localMode ? "/" : "/(auth)/sign-in");
    }
  }, [
    isAuthenticated,
    isIdeEmbed,
    ideAutoSigningIn,
    isLoading,
    localMode,
    router,
  ]);

  useEffect(() => {
    if (!isLoading) csMark("app:layout:auth-resolved", { isAuthenticated });
  }, [isLoading, isAuthenticated]);

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
  }, [isAuthenticated, user]);

  const suppressNarrowAppHeader =
    isProjectDetail ||
    isBillingPage ||
    isNotificationsPage ||
    isApiKeysPage ||
    isProfilePage ||
    isAccountPage ||
    isSearchPage ||
    isProjectChatsPage;
  // Project chat has its own header, but it still uses the same native drawer
  // underneath. Keep horizontal drawer gestures enabled there so the sheet
  // can be opened and dismissed by swiping just like Home.
  const nativeDrawerSwipe =
    !isWide &&
    !isIdeEmbed &&
    !phoneSheetOpen &&
    (!suppressNarrowAppHeader || isProjectDetail);
  const nativeSheetDrawer = !isWide && !isIdeEmbed;
  const drawer = useNativeSheetDrawer({
    windowWidth: width,
    isDark,
    swipeEnabled: nativeDrawerSwipe,
    closedCanvas: isHomePage && isDark ? NATIVE_PHONE_HOME_CANVAS : undefined,
  });
  const { drawerOpen, closeDrawer, toggleDrawer, openDrawer, resetDrawer } =
    drawer;

  useEffect(() => {
    if (phoneSheetOpen && drawerOpen) closeDrawer();
  }, [closeDrawer, drawerOpen, phoneSheetOpen]);

  useEffect(() => {
    let pendingFrame: number | null = null;
    const unsubscribe = projectSidebarEvents.subscribeOpenProject(() => {
      if (isWide || isIdeEmbed) return;
      if (drawerOpen) {
        closeDrawer();
        return;
      }
      // Let the sidebar commit its focused-project state before the drawer
      // animation starts. Otherwise the default sidebar renders for the first
      // frame and then crossfades into the project panel.
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        openDrawer();
      });
    });
    return () => {
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      unsubscribe();
    };
  }, [closeDrawer, drawerOpen, isIdeEmbed, isWide, openDrawer]);

  useEffect(() => {
    if (!isWide && !isAccountPage) return;
    resetDrawer();
  }, [isAccountPage, isWide, resetDrawer]);

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

  const showSidebar =
    isWide &&
    !useAgentShell &&
    !isIdeEmbed &&
    !isSettingsPage &&
    !isBillingPage;
  const nativeEdgeToEdgeChrome =
    isNativeApp && !isIdeEmbed && (isHomePage || isSearchPage || isAccountPage);

  return (
    <NativeSheetDrawerShell
      isWide={isWide}
      nativeSheetDrawer={nativeSheetDrawer}
      canvas={
        isHomePage && isDark ? NATIVE_PHONE_HOME_CANVAS : nativeDrawerCanvas
      }
      safeAreaEdges={nativeEdgeToEdgeChrome ? ["left", "right"] : undefined}
      sidebarWide={showSidebar ? <AppSidebar /> : null}
      sidebarSheet={<AppSidebar isOpen={drawerOpen} onClose={closeDrawer} />}
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
      bottomNav={!isWide && !isIdeEmbed ? <MobileBottomNav /> : null}
      drawer={drawer}
    >
      {localMode && !isIdeEmbed ? <RecordingIndicator /> : null}
      {useAgentShell ? (
        <WorkspaceAgentShell>
          <Slot />
        </WorkspaceAgentShell>
      ) : useMobileWorkspaceShell ? (
        <MobileWorkspaceShell>
          <Slot />
        </MobileWorkspaceShell>
      ) : (
        <Slot />
      )}
    </NativeSheetDrawerShell>
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
      <AppLayoutInner />
    </DomainProvider>
  );
}
