// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useGlobalSearchParams, useSegments } from "expo-router";
import { useAuth } from "../../contexts/auth";
import { api, createHttpClient } from "../api";
import { compareVersions, resolveAppVersion } from "../app-version";
import { selectWhatsNewRelease, type WhatsNewRelease } from "./eligibility";
import catalog from "./releases.generated.json";

export type { WhatsNewRelease } from "./eligibility";

const releases = catalog as WhatsNewRelease[];
const SEEN_KEY_PREFIX = "shogo:whats-new-seen:";

function getForcedRelease(
  value: string | string[] | undefined,
): WhatsNewRelease | null {
  if (typeof value !== "string") return null;
  return (
    releases.find(
      (release) =>
        release.announce && compareVersions(release.version, value) === 0,
    ) ?? null
  );
}

export function useWhatsNew() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const segments = useSegments();
  const params = useGlobalSearchParams<{ whatsNew?: string }>();
  const requestedVersion =
    typeof params.whatsNew === "string" ? params.whatsNew : undefined;
  const forcedRelease = useMemo(
    () => getForcedRelease(requestedVersion),
    [requestedVersion],
  );
  const forcedDismissed = useRef<string | null>(null);
  const [release, setRelease] = useState<WhatsNewRelease | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);

  const isAppRoute = segments[0] === "(app)";
  const canShow = isAppRoute && isAuthenticated && !authLoading;

  useEffect(() => {
    let cancelled = false;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setRelease(null);
    setVisible(false);

    if (!canShow) {
      setLoading(false);
      return;
    }

    async function load() {
      const forced =
        forcedRelease && forcedDismissed.current !== requestedVersion
          ? forcedRelease
          : null;
      if (forced) {
        setRelease(forced);
        setVisible(true);
        setLoading(false);
        return;
      }

      const [appVersion, meResponse] = await Promise.all([
        resolveAppVersion(),
        createHttpClient().get<{
          data?: {
            createdAt?: string;
            lastSeenAnnouncementVersion?: string | null;
          };
        }>("/api/me"),
      ]);
      if (cancelled) return;

      const me = meResponse.data?.data;
      const candidate = selectWhatsNewRelease(
        releases,
        appVersion,
        me?.lastSeenAnnouncementVersion,
        me?.createdAt ?? user?.createdAt,
      );
      if (!candidate) {
        setLoading(false);
        return;
      }

      const localSeen = await AsyncStorage.getItem(
        `${SEEN_KEY_PREFIX}${user?.id ?? "unknown"}`,
      );
      if (cancelled) return;
      if (localSeen && compareVersions(localSeen, candidate.version) >= 0) {
        setLoading(false);
        return;
      }

      setRelease(candidate);
      setLoading(false);
      showTimer = setTimeout(() => {
        if (!cancelled) setVisible(true);
      }, 1500);
    }

    void load().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      if (showTimer) clearTimeout(showTimer);
    };
  }, [canShow, forcedRelease, requestedVersion, user?.createdAt, user?.id]);

  const dismiss = useCallback(() => {
    if (!release) return;
    setVisible(false);
    if (forcedRelease?.version === release.version) {
      forcedDismissed.current = requestedVersion ?? release.version;
      return;
    }

    const userId = user?.id;
    if (!userId) return;
    void AsyncStorage.setItem(`${SEEN_KEY_PREFIX}${userId}`, release.version);
    void api
      .markAnnouncementSeen(createHttpClient(), release.version)
      .catch(() => {
        // The local marker keeps a transient API failure from reopening the modal.
      });
  }, [forcedRelease, release, requestedVersion, user?.id]);

  return {
    release,
    visible: visible && !loading,
    dismiss,
    latestRelease: releases.find((item) => item.announce) ?? null,
  };
}
