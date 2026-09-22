// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { compareVersions } from "../version";

export interface WhatsNewRelease {
  version: string;
  slug: string;
  title: string;
  date: string;
  announce: boolean;
  intro: string;
  highlights: Array<{
    title: string;
    description: string;
    icon?: string;
  }>;
  url: string;
}

function isBeforeRelease(
  createdAt: string | Date | undefined,
  releaseDate: string,
): boolean {
  if (!createdAt) return true;
  const created = new Date(createdAt).getTime();
  const release = new Date(`${releaseDate}T00:00:00.000Z`).getTime();
  return (
    Number.isFinite(created) && Number.isFinite(release) && created < release
  );
}

export function selectWhatsNewRelease(
  releases: WhatsNewRelease[],
  appVersion: string | null,
  lastSeenVersion: string | null | undefined,
  createdAt: string | Date | undefined,
): WhatsNewRelease | null {
  if (!appVersion) return null;
  return (
    releases.find(
      (release) =>
        release.announce &&
        compareVersions(appVersion, release.version) >= 0 &&
        (!lastSeenVersion ||
          compareVersions(release.version, lastSeenVersion) > 0) &&
        isBeforeRelease(createdAt, release.date),
    ) ?? null
  );
}
