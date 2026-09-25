// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace identity row for the phone chat drawer, plus the sheet that
 * switches personal and team workspaces.
 */

import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronDown } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import {
  useDomainActions,
  useDomainHttp,
  useProjectCollection,
  useWorkspaceCollection,
} from "../../contexts/domain";
import { useAuth } from "../../contexts/auth";
import { usePostHogSafe } from "../../contexts/posthog";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { EVENTS, trackEvent } from "../../lib/analytics";
import { api } from "../../lib/api";
import { usePlatformConfig } from "../../lib/platform-config";
import {
  reloadAfterWorkspaceSwitch,
  scheduleWorkspaceSwitch,
} from "../../lib/switch-workspace";
import { setActiveWorkspaceId } from "../../lib/workspace-store";
import { NativePhoneSheet } from "../phone/NativePhoneSheet";
import { CreateWorkspaceModal } from "./sidebar/CreateWorkspaceModal";
import {
  WorkspaceMenuSection,
  workspaceKindBadge,
} from "./sidebar/WorkspaceMenuSection";

const EMPTY_BILLING = { hasActiveSubscription: false };

export function MobileWorkspaceSwitcherRow({
  onPress,
}: {
  onPress: () => void;
}) {
  const workspace = useActiveWorkspace();
  const badge = workspaceKindBadge(workspace ?? {});
  const initial = workspace?.name?.[0]?.toUpperCase() ?? "W";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Switch workspace. Current workspace ${workspace?.name ?? "Workspace"}, ${badge.label}`}
      onPress={onPress}
      className="mx-4 mb-3 flex-row items-center gap-2 rounded-2xl bg-background px-3 py-2.5 active:bg-muted"
    >
      <View className="h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
        <Text className="text-sm font-medium text-primary">{initial}</Text>
      </View>
      <Text
        className="min-w-0 flex-1 text-sm font-semibold text-foreground"
        numberOfLines={1}
      >
        {workspace?.name ?? "Workspace"}
      </Text>
      <View
        className={cn(
          "rounded px-1.5 py-0.5",
          badge.highlighted ? "bg-primary/10" : "bg-muted"
        )}
      >
        <Text
          className={cn(
            "text-xs",
            badge.highlighted
              ? "font-medium text-primary"
              : "text-muted-foreground"
          )}
        >
          {badge.label}
        </Text>
      </View>
      <ChevronDown size={16} className="text-muted-foreground" />
    </Pressable>
  );
}

export function MobileWorkspaceSwitcherSheet({
  visible,
  onClose,
  onSwitched,
}: {
  visible: boolean;
  onClose: () => void;
  onSwitched?: () => void;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { localMode } = usePlatformConfig();
  const http = useDomainHttp();
  const actions = useDomainActions();
  const posthog = usePostHogSafe();
  const workspaces = useWorkspaceCollection();
  const projects = useProjectCollection();
  const currentWorkspace = useActiveWorkspace();
  const [createOpen, setCreateOpen] = useState(false);

  const allWorkspaces = workspaces?.all ?? [];
  const hasPersonalWorkspace = allWorkspaces.some(
    (workspace: { kind?: string }) => workspace.kind === "personal"
  );
  const hasTeamWorkspace = allWorkspaces.some(
    (workspace: { kind?: string }) => workspace.kind === "team"
  );

  useEffect(() => {
    if (!visible) return;
    void workspaces.loadAll().catch(() => undefined);
  }, [visible, workspaces]);

  const go = useCallback(
    (href: string) => {
      router.push(href as never);
    },
    [router]
  );

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === currentWorkspace?.id) return;
      trackEvent(posthog, EVENTS.WORKSPACE_SWITCHED);
      scheduleWorkspaceSwitch(workspaceId, projects, reloadAfterWorkspaceSwitch);
      onSwitched?.();
      onClose();
    },
    [currentWorkspace?.id, onClose, onSwitched, posthog, projects]
  );

  const handleCreateWorkspace = useCallback(() => {
    onClose();
    if (hasTeamWorkspace) {
      onSwitched?.();
      router.push("/(app)/new-workspace" as never);
      return;
    }
    setCreateOpen(true);
  }, [hasTeamWorkspace, onClose, onSwitched, router]);

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (!user?.id) return;
      try {
        const created = await actions.createWorkspace(name, undefined, user.id);
        if (created?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED);
          setActiveWorkspaceId(created.id);
          await workspaces.loadAll();
          projects.clear();
          await projects.loadAll({ workspaceId: created.id });
          reloadAfterWorkspaceSwitch();
        }
      } catch (err) {
        console.warn("Failed to create workspace:", err);
      }
    },
    [actions, posthog, projects, user?.id, workspaces]
  );

  const handleCreatePersonalWorkspace = useCallback(async () => {
    try {
      const created = await api.createPersonalWorkspace(http);
      if (created?.id) {
        trackEvent(posthog, EVENTS.WORKSPACE_CREATED);
        setActiveWorkspaceId(created.id);
        await workspaces.loadAll();
        projects.clear();
        await projects.loadAll({ workspaceId: created.id });
        reloadAfterWorkspaceSwitch();
      }
    } catch (err) {
      console.warn("Failed to create personal workspace:", err);
    }
  }, [http, posthog, projects, workspaces]);

  return (
    <>
      <NativePhoneSheet
        visible={visible}
        onClose={onClose}
        title="Workspaces"
        scroll
        draggable
      >
        <WorkspaceMenuSection
          isNative
          includePlan={false}
          showBilling={false}
          localMode={localMode}
          workspaces={allWorkspaces}
          currentWorkspace={currentWorkspace}
          billingData={EMPTY_BILLING}
          workspacePlan={null}
          allPlans={{}}
          hasPersonalWorkspace={hasPersonalWorkspace}
          onNavigate={go}
          onSwitchWorkspace={handleSwitchWorkspace}
          onCreateWorkspace={handleCreateWorkspace}
          onCreatePersonalWorkspace={() => {
            void handleCreatePersonalWorkspace();
          }}
          onClose={onClose}
        />
      </NativePhoneSheet>
      <CreateWorkspaceModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={(name) => {
          setCreateOpen(false);
          void handleCreateWorkspaceSubmit(name);
        }}
      />
    </>
  );
}
