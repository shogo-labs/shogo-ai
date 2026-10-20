// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `Workspace.settings` encoding helpers.
 *
 * The column has the same shape hazard as `Project.settings` (see
 * `project-settings.ts`): `Json?` on Postgres, `String?` on SQLite, and a
 * client that stringifies before writing stores a jsonb *string scalar* that
 * Prisma reads back as a string. These delegate to the shared helpers so both
 * settings columns are read and written the same way — only the names differ
 * at the call site, because a workspace's settings are never a project's.
 */

import {
  encodeProjectSettingsForWrite,
  normalizeProjectSettings,
  parseProjectSettings,
} from './project-settings'

/** Read `Workspace.settings` as an object, or null when absent/unparseable. */
export function parseWorkspaceSettings(raw: unknown): Record<string, unknown> | null {
  return parseProjectSettings(raw)
}

/** Coerce an inbound `settings` value into the object form the column holds. */
export function normalizeWorkspaceSettings(raw: unknown): unknown {
  return normalizeProjectSettings(raw)
}

/** Encode a settings object for a Prisma write (object on PG, string on SQLite). */
export function encodeWorkspaceSettingsForWrite(value: Record<string, unknown>): unknown {
  return encodeProjectSettingsForWrite(value)
}
