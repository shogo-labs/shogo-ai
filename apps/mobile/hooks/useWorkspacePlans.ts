// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace plan map for Account and the sidebar. `refreshKey` lets the
 * sidebar refetch after a subscription change without a second fetch helper.
 */

import { useEffect, useState } from "react";
import { useDomainHttp } from "../contexts/domain";
import { api } from "../lib/api";

export type WorkspacePlanRecord = { planId: string; status: string | null };

export function useWorkspacePlans(
  workspaceIds: string[],
  enabled: boolean,
  refreshKey?: unknown,
): Record<string, WorkspacePlanRecord> {
  const http = useDomainHttp();
  const [allPlans, setAllPlans] = useState<Record<string, WorkspacePlanRecord>>(
    {},
  );
  const idsKey = workspaceIds.join(",");

  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (!enabled || !ids.length) return;
    let cancelled = false;
    api
      .getWorkspacePlans(http, ids)
      .then((plans) => {
        if (!cancelled) setAllPlans(plans);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, http, idsKey, refreshKey]);

  return allPlans;
}
