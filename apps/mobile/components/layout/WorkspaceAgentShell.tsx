// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop-first shell for the staged Workspace Agent rollout.
 *
 * It deliberately renders existing routes as children. This makes the shell a
 * visual/navigation migration rather than a second application surface, so
 * project, billing, permissions, and deep-link behavior remain unchanged.
 */

import { useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import {
  Activity,
  Bot,
  Boxes,
  ListTodo,
  MessageSquare,
  Search,
  Settings,
  Store,
  Target,
  X,
} from "lucide-react-native";
import { ShogoLogoMark } from "../branding/ShogoLogoMark";
import SettingsPage from "../../app/(app)/settings";
import { CommandPalette } from "./CommandPalette";
import { WorkspaceConversationSidebar } from "./WorkspaceConversationSidebar";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { cn } from "@shogo/shared-ui/primitives";

interface NavItem {
  label: string;
  href?: string;
  icon: typeof Bot;
  action?: "search";
}

function routeIsActive(pathname: string, href: string): boolean {
  if (href === "/(app)")
    return (
      pathname === "/" || pathname === "/(app)" || pathname === "/(app)/index"
    );
  const normalized = href.replace("/(app)", "");
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export function WorkspaceAgentShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { width, height } = useWindowDimensions();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const experience = useWorkspaceExperience();
  const primaryNav: NavItem[] = [
    { label: "Chat", href: "/(app)", icon: MessageSquare },
    { label: "Search", icon: Search, action: "search" },
    ...(experience.kind === "team"
      ? [{ label: "Tasks", href: "/(app)/tasks", icon: ListTodo } as NavItem]
      : []),
    ...(experience.showGoalsNav
      ? [
          { label: "Goals", href: "/(app)/goals", icon: Target },
          { label: "Activity", href: "/(app)/activity", icon: Activity },
        ]
      : []),
    { label: "Canvases", href: "/(app)/canvases", icon: Boxes },
    ...(experience.showMarketplace
      ? [
          {
            label: "Marketplace",
            href: "/(app)/marketplace",
            icon: Store,
          } as NavItem,
        ]
      : []),
  ];

  const openSettings = () => {
    setSettingsOpen(true);
  };

  const openSearch = () => {
    // On web, mounting a full-screen modal during the rail button's press can
    // let the new backdrop receive that same interaction and dismiss itself.
    // Open on the next frame once the originating press has fully finished.
    requestAnimationFrame(() => setSearchOpen(true));
  };

  const closeSearch = () => {
    setSearchOpen(false);
  };

  return (
    <View className="relative flex-row flex-1 bg-background">
      <View className="w-14 shrink-0 items-center border-r border-border/70 bg-card py-3">
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Shogo home"
          onPress={() => router.push("/(app)" as any)}
          className="mb-5 h-9 w-9 items-center justify-center rounded-xl active:bg-muted"
        >
          <ShogoLogoMark className="h-6 w-6" />
        </Pressable>
        <View className="items-center gap-2">
          {primaryNav.map(({ href, label, icon: Icon, action }) => {
            const active =
              action === "search"
                ? searchOpen
                : href
                ? routeIsActive(pathname, href)
                : false;
            return (
              <Pressable
                key={href ?? action}
                accessibilityRole={action ? "button" : "link"}
                accessibilityLabel={label}
                accessibilityState={{ selected: active }}
                onPress={() =>
                  action === "search" ? openSearch() : router.push(href as any)
                }
                className={cn(
                  "h-9 w-9 items-center justify-center rounded-lg",
                  active ? "bg-primary/12" : "active:bg-muted"
                )}
              >
                <Icon
                  size={18}
                  className={active ? "text-primary" : "text-muted-foreground"}
                />
              </Pressable>
            );
          })}
        </View>
        <View className="mt-auto items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open settings"
            onPress={openSettings}
            className={cn(
              "h-9 w-9 items-center justify-center rounded-lg",
              settingsOpen ? "bg-primary/12" : "active:bg-muted"
            )}
          >
            <Settings
              size={18}
              className={
                settingsOpen ? "text-primary" : "text-muted-foreground"
              }
            />
          </Pressable>
        </View>
      </View>

      <WorkspaceConversationSidebar />

      <View className="min-w-0 flex-1 bg-background">{children}</View>

      <CommandPalette visible={searchOpen} onClose={closeSearch} />

      <Modal
        visible={settingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View className="flex-1 items-center justify-center bg-black/45 p-6">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close settings"
            onPress={() => setSettingsOpen(false)}
            className="absolute inset-0"
          />
          <View
            accessibilityViewIsModal
            className="overflow-hidden rounded-[28px] border border-border bg-background"
            style={{
              width: Math.min(width - 48, 1000),
              height: Math.min(height - 48, 760),
              shadowColor: "#000",
              shadowOpacity: 0.24,
              shadowRadius: 30,
              elevation: 20,
            }}
          >
            <SettingsPage onClose={() => setSettingsOpen(false)} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close settings"
              onPress={() => setSettingsOpen(false)}
              className="absolute right-4 top-4 h-9 w-9 items-center justify-center rounded-full bg-background/90 active:bg-muted"
            >
              <X size={18} className="text-foreground" />
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}
