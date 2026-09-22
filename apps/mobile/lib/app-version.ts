// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import * as Application from "expo-application";
import Constants from "expo-constants";

export { compareVersions } from "./version";

type DesktopBridge = {
  getDeviceInfo?: () => Promise<{ appVersion?: string }>;
};

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value || !/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    return null;
  }
  return value;
}

/**
 * Resolve the version baked into the current bundle or native binary.
 *
 * EXPO_PUBLIC_APP_VERSION is intentionally checked first: an OTA bundle can
 * be newer than the native binary, and the release tag is the source of truth
 * for that bundle.
 */
export function getAppVersion(): string | null {
  return (
    normalizeVersion(process.env.EXPO_PUBLIC_APP_VERSION) ??
    normalizeVersion(Application.nativeApplicationVersion) ??
    normalizeVersion(Constants.expoConfig?.version)
  );
}

/** Resolve the Electron renderer's version when running inside the desktop app. */
export async function resolveAppVersion(): Promise<string | null> {
  const initial = getAppVersion();
  if (initial) return initial;

  if (typeof window !== "undefined") {
    const bridge = (window as typeof window & { shogoDesktop?: DesktopBridge })
      .shogoDesktop;
    if (bridge?.getDeviceInfo) {
      try {
        return normalizeVersion((await bridge.getDeviceInfo()).appVersion);
      } catch {
        // Fall through to null for development shells without the bridge.
      }
    }
  }

  return null;
}
