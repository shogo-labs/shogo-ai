// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The release this API process is running.
 *
 * Only the web overlay used to pin a version (`SHOGO_APP_VERSION`), so
 * production's api pods reported `0.0.0` and nothing in the API could say
 * which tag was "latest" — which is why the admin dashboard could not answer
 * "how many desktop users are on the current version".
 *
 * `APP_VERSION` is the api's own env (pinned per release by the deploy);
 * `SHOGO_APP_VERSION` is accepted as a fallback so a single pin covers both
 * surfaces. Anything that is obviously not a release (missing, `0.0.0`, an
 * unrendered k8s `_PLACEHOLDER`) reads as "unknown" instead of a fake tag.
 */
export const UNKNOWN_APP_VERSION = '0.0.0'

export function resolveAppVersion(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const candidate of [env.APP_VERSION, env.SHOGO_APP_VERSION]) {
    const value = candidate?.trim()
    if (!value) continue
    if (value === UNKNOWN_APP_VERSION) continue
    if (value.includes('PLACEHOLDER')) continue
    return value
  }
  return null
}

/** The deployed tag, or null when this process cannot know it. */
export function deployedAppVersion(): string | null {
  return resolveAppVersion()
}

/** The deployed tag for display / comparison, `0.0.0` when unknown. */
export function deployedAppVersionOrUnknown(): string {
  return deployedAppVersion() ?? UNKNOWN_APP_VERSION
}
