// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared /api/me admin-portal check used by the sidebar and Account screen.
 */

import { useEffect, useState } from "react";
import { useDomainHttp } from "../contexts/domain";
import { api } from "../lib/api";
import { hasAdminPortalAccess } from "../lib/admin-portal-access";

export function useHasAdminAccess(userId: string | undefined): boolean {
  const http = useDomainHttp();
  const [hasAdminAccess, setHasAdminAccess] = useState(false);

  useEffect(() => {
    setHasAdminAccess(false);
    if (!userId || !http) return;
    let cancelled = false;
    api
      .getMe(http)
      .then((data) => {
        if (cancelled) return;
        setHasAdminAccess(hasAdminPortalAccess(data));
      })
      .catch(() => {
        if (!cancelled) setHasAdminAccess(false);
      });
    return () => {
      cancelled = true;
    };
  }, [http, userId]);

  return hasAdminAccess;
}
