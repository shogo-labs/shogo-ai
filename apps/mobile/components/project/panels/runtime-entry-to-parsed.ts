// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure mapping function used by Monitor's `LogsPanel` to fold the typed
 * `RuntimeLogEntry` stream back into the legacy `ParsedLogEntry` shape
 * the existing UI expects. Lives in its own file (no `react-native`
 * import) so it can be unit-tested without booting the RN shim chain.
 *
 * Contract:
 *   - The dispatcher's explicit `level` (info / warn / error) wins over
 *     the parser's heuristic. We don't want a `level: 'error'` entry
 *     downgraded to `info` just because its body lacks a literal "ERROR"
 *     token, and conversely we don't want a `level: 'info'` entry
 *     promoted to error when the body happens to mention "ERROR".
 *   - The bracketed `[source]` prefix is preserved in the visible message
 *     so a single Monitor list can mix build / console / canvas-error
 *     lines without a separate filter UI.
 */

import { parseLogLine, type ParsedLogEntry } from './log-utils'
import type { RuntimeLogEntry } from '../../lib/runtime-logs/runtime-log-store'

export function runtimeEntryToParsed(entry: RuntimeLogEntry): ParsedLogEntry {
  const tagged = `[${entry.source}] ${entry.text}`
  const parsed = parseLogLine(tagged)
  return { ...parsed, level: entry.level }
}
