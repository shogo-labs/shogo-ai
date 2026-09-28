// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared "create an included (child) workspace" flow for Business/Enterprise
 * admins. Used by every "Create workspace" entry point so they all pool under
 * the same parent and handle failures the same way.
 */

import { useCallback, useMemo } from "react";
import { useRouter } from "expo-router";
import {
  Toast,
  ToastDescription,
  ToastTitle,
  useToast,
} from "@/components/ui/toast";
import { useAuth } from "../contexts/auth";
import {
  useDomainHttp,
  useProjectCollection,
  useWorkspaceCollection,
} from "../contexts/domain";
import { usePostHogSafe } from "../contexts/posthog";
import { EVENTS, trackEvent } from "../lib/analytics";
import { api } from "../lib/api";
import { setActiveWorkspaceId } from "../lib/workspace-store";
import { useWorkspacePlans } from "./useWorkspacePlans";
import {
  selectPooledWorkspaceParent,
  type PooledWorkspaceCandidate,
} from "./pooledWorkspaceParent";

/** Server rejections that mean "this user can't pool here; offer checkout instead". */
const CHECKOUT_FALLBACK_CODES = new Set(["forbidden", "plan_required"]);

export function usePooledWorkspaceCreation({
  workspaces,
  currentWorkspaceId,
  enabled,
  onCreated,
}: {
  workspaces: PooledWorkspaceCandidate[];
  currentWorkspaceId: string | undefined;
  enabled: boolean;
  /** Runs after the new workspace is active and its projects are loading. */
  onCreated?: (workspaceId: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const http = useDomainHttp();
  const { user } = useAuth();
  const posthog = usePostHogSafe();
  const workspaceCollection = useWorkspaceCollection();
  const projects = useProjectCollection();

  const workspaceIds = useMemo(
    () => workspaces.map((workspace) => workspace.id),
    [workspaces],
  );
  const plans = useWorkspacePlans(workspaceIds, enabled);
  const parent = useMemo(
    () => selectPooledWorkspaceParent(workspaces, currentWorkspaceId, plans),
    [currentWorkspaceId, plans, workspaces],
  );

  const showError = useCallback(
    (message: string) => {
      toast.show({
        placement: "top",
        duration: 5000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="error">
            <ToastTitle>Failed to create workspace</ToastTitle>
            <ToastDescription>{message}</ToastDescription>
          </Toast>
        ),
      });
    },
    [toast],
  );

  /**
   * Returns `true` once the workspace exists, `false` if it wasn't created
   * (so a caller's modal can stay open and keep the typed name).
   */
  const createPooledWorkspace = useCallback(
    async (name: string): Promise<boolean> => {
      if (!user?.id || !parent) return false;
      let createdId: string;
      try {
        const created = await api.createChildWorkspace(http, {
          name,
          parentWorkspaceId: parent.id,
          ownerId: user.id,
        });
        createdId = created.id;
      } catch (error: any) {
        const code = String(error?.code ?? "").toLowerCase();
        if (CHECKOUT_FALLBACK_CODES.has(code)) {
          router.push("/(app)/new-workspace" as never);
        } else {
          console.warn("Failed to create pooled workspace:", error);
          showError(
            error?.message && !String(error.message).startsWith("createChildWorkspace")
              ? String(error.message)
              : "Could not create the workspace. Please try again.",
          );
        }
        return false;
      }

      trackEvent(posthog, EVENTS.WORKSPACE_CREATED);
      setActiveWorkspaceId(createdId);
      try {
        await workspaceCollection.loadAll();
        projects.clear();
        await projects.loadAll({ workspaceId: createdId });
      } catch (error) {
        console.warn("Failed to refresh after creating workspace:", error);
      }
      onCreated?.(createdId);
      return true;
    },
    [
      http,
      onCreated,
      parent,
      posthog,
      projects,
      router,
      showError,
      user?.id,
      workspaceCollection,
    ],
  );

  return { parent, createPooledWorkspace };
}
