// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The `on|off|<projectId>[,<projectId>…]` form of the publish switches
 * (`PUBLISH_POSTGRES`, `PUBLISH_BUILD_IMAGES`).
 *
 * Both switches started life as a region-wide `on`/`off` because the rollout
 * they gated was per region. Publishing Postgres to production does not work
 * that way: the subjects are two apps, and moving every server app in a region
 * in one step is how a bad build reaches customers. A list keeps one knob —
 * "on for these projects, off for everything else" — so the same variable that
 * rolls back a region selects the projects being moved.
 *
 * Entries match a project id exactly, or by a prefix of at least
 * {@link MIN_PREFIX_ID_LENGTH} characters: an overlay written by hand is easier
 * to read with `5925615d,c7d51ded`, and a project id is a UUID, so a six-character
 * prefix is unambiguous in practice.
 */

/** Shortest prefix accepted for a listed project id. */
export const MIN_PREFIX_ID_LENGTH = 6

export type PublishFlag =
  | { kind: 'on'; raw: string }
  | { kind: 'off'; raw: string }
  | { kind: 'list'; ids: string[]; raw: string }
  | { kind: 'unset'; raw: '' }
  | { kind: 'invalid'; raw: string }

function isProjectIdLike(entry: string): boolean {
  return /^[0-9a-f][0-9a-f-]*$/i.test(entry) && entry.replace(/-/g, '').length >= MIN_PREFIX_ID_LENGTH
}

/**
 * Read one switch's value.
 *
 * `invalid` is not the same as `unset`: a value someone meant as a list but
 * mistyped must not silently fall back to the region's default, or a rollout
 * step reads as applied while nothing moved.
 */
export function parsePublishFlag(raw: string | undefined | null): PublishFlag {
  const value = (raw ?? '').trim()
  if (!value) return { kind: 'unset', raw: '' }
  const lower = value.toLowerCase()
  if (lower === 'on' || lower === 'true' || lower === '1') return { kind: 'on', raw: value }
  if (lower === 'off' || lower === 'false' || lower === '0') return { kind: 'off', raw: value }
  const ids = lower
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (ids.length === 0) return { kind: 'invalid', raw: value }
  if (ids.some((entry) => !isProjectIdLike(entry))) return { kind: 'invalid', raw: value }
  return { kind: 'list', ids, raw: value }
}

/** Whether a project id is named by a list entry (exact, or a long-enough prefix). */
export function listNamesProject(ids: string[], projectId: string | null | undefined): boolean {
  if (!projectId) return false
  const target = projectId.toLowerCase()
  return ids.some((raw) => {
    const entry = raw.trim().toLowerCase()
    return entry.length > 0 && (target === entry || target.startsWith(entry))
  })
}

/**
 * The switch's verdict for one project, or null when it has no opinion and the
 * caller's own configuration decides.
 *
 * A list with no project id is a `false`: every publish is project-scoped, so a
 * caller that cannot name its project has not been listed.
 */
export function publishFlagAllows(flag: PublishFlag, projectId: string | null | undefined): boolean | null {
  switch (flag.kind) {
    case 'on':
      return true
    case 'off':
      return false
    case 'list':
      return listNamesProject(flag.ids, projectId)
    default:
      return null
  }
}
