// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Single source of truth for whether the `search` tool is available.
 *
 * The semantic `search` tool is only registered when `SHOGO_SEARCH_ENABLED=1`
 * (reindex-on-query hangs when local indexing is off — see gateway-tools.ts).
 * Production pods do NOT set this flag, so `search` is absent from the tool
 * list there. Several prompts/guides historically advertised `search`
 * unconditionally, which made weak models call a tool that doesn't exist and
 * get "Tool search not found" (100% failure in prod). Gate every advertisement
 * behind this helper so the prompt surface always matches the registered tools.
 */
export function isSearchEnabled(): boolean {
  return process.env.SHOGO_SEARCH_ENABLED === '1'
}
