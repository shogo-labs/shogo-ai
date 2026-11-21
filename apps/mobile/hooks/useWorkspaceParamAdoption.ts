// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Open the workspace a link names.
 *
 * `?workspace=<id>` is how a link addresses a workspace: `/agent?workspace=`,
 * `/activity?workspace=`, a shared file link (`&file=`), or `/?workspace=` after
 * Stripe checkout. On wide web the sidebar has always adopted it; a phone has no
 * sidebar and no workspace switcher, so a link into a workspace on a paired
 * computer landed in the companion's own space and stayed there — the phone
 * could not open a computer's workspace at all (SHO-494).
 *
 * Adopting is a property of the shell, not of the sidebar, so it lives here and
 * the app shell calls it once. Both shells mount that shell, so the phone and
 * the web sidebar cannot drift apart.
 *
 * A link may name a workspace this account is not in. That must change nothing
 * (SHO-284): `adoptableWorkspaceParam` answers null, and the screen keeps the
 * workspace the person was already reading rather than being thrown out of it.
 *
 * The param is read for the *whole* route tree (`useGlobalSearchParams`): a
 * layout's own `useLocalSearchParams` only sees its own segment's params, and
 * this hook runs in the layout above every screen.
 */
import { useEffect, useRef } from "react";
import { useGlobalSearchParams } from "expo-router";
import { useProjectCollection, useWorkspaceCollection } from "../contexts/domain";
import {
  adoptableWorkspaceParam,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../lib/workspace-store";

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function useWorkspaceParamAdoption(): void {
  const params = useGlobalSearchParams<{ workspace?: string | string[] }>();
  const param = single(params.workspace);
  const workspaces = useWorkspaceCollection();
  const projects = useProjectCollection();
  // The last param this hook acted on. A navigation re-runs the effect with the
  // same URL, and a person who then picks another workspace in the switcher
  // must keep it: only a *different* link moves them again.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!param || handled.current === param) return;
    handled.current = param;
    void (async () => {
      try {
        await workspaces.loadAll();
      } catch {
        handled.current = null;
        return;
      }
      const ownIds = (workspaces.all ?? []).map((w: { id: string }) => w.id);
      const adopted = adoptableWorkspaceParam(ownIds, param);
      if (!adopted || adopted === getActiveWorkspaceId()) return;
      setActiveWorkspaceId(adopted);
      projects.loadAll({ workspaceId: adopted }).catch((error: unknown) => {
        console.error("[useWorkspaceParamAdoption] Failed to load projects:", error);
      });
    })();
  }, [param]);
}
