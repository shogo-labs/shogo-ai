// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What the Plans tab should show from the live chat plan.
 *
 * Chat keeps the latest plan in `pendingPlan` after create_plan finishes.
 * The stream-derived snapshot is cleared the moment `isStreaming` flips
 * false — if we also clear the shared PlanStreamContext, Plans shows
 * "No plans yet" even though the dock still has the card.
 */
export function planToPublishToStream<T>(opts: {
  derivedStreamingPlan: T | null
  isStreaming: boolean
  pendingPlan: T | null
  confirmedPlan: T | null
}): T | null {
  if (opts.derivedStreamingPlan) return opts.derivedStreamingPlan
  if (opts.isStreaming) return null
  return opts.pendingPlan ?? opts.confirmedPlan
}

/**
 * Same filename rule as PlansPanel: only `*.plan.md` basenames count.
 * Invalid or missing paths stay listed as the in-memory row.
 */
export function planFilenameFromPath(filepath?: string | null): string | undefined {
  if (!filepath) return undefined
  const filename = filepath.replace(/^\/+/, "").replace(/\\/g, "/").split("/").filter(Boolean).pop()
  if (!filename || !/^[a-zA-Z0-9._-]+\.plan\.md$/.test(filename)) return undefined
  return filename
}

export function shouldListInMemoryPlan(
  streamingPlan: { filepath?: string } | null,
  listedFilenames: readonly string[],
): boolean {
  if (!streamingPlan) return false
  const filename = planFilenameFromPath(streamingPlan.filepath)
  if (!filename) return true
  return !listedFilenames.includes(filename)
}
