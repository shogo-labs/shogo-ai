// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A tree listing can come back truncated when the runtime's walk budget runs
// out (a busy runtime at project open, antivirus scanning each stat). Every
// name is still present, but some folders are unexpanded stubs. The explorer
// shows that listing straight away and quietly lists again a few times.

import type { WorkspaceService, WsTreeListing } from "./types";

export const TRUNCATED_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/** `depth` only reaches backends without `listTreeWithMeta` (LocalFs walks up front). */
export async function listTreeMeta(svc: WorkspaceService, path?: string, depth?: number): Promise<WsTreeListing> {
  if (svc.listTreeWithMeta) return svc.listTreeWithMeta(path);
  return { nodes: await svc.listTree(path, depth), truncated: false };
}

export interface FollowTruncatedOptions {
  fetch: () => Promise<WsTreeListing>;
  /** Called with every retry's listing, complete or not. */
  apply: (listing: WsTreeListing) => void;
  /** `stillTruncated` is true when every retry came back truncated. */
  onSettled: (stillTruncated: boolean) => void;
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Re-list after each delay until a listing comes back complete. Returns a
 * cancel function; once cancelled nothing more is applied or reported.
 * A failed fetch counts as a truncated attempt.
 */
export function followTruncatedListing(options: FollowTruncatedOptions): () => void {
  const { fetch, apply, onSettled, delays = TRUNCATED_RETRY_DELAYS_MS, sleep = defaultSleep } = options;
  let cancelled = false;
  void (async () => {
    for (const delay of delays) {
      await sleep(delay);
      if (cancelled) return;
      let listing: WsTreeListing;
      try {
        listing = await fetch();
      } catch {
        continue;
      }
      if (cancelled) return;
      apply(listing);
      if (!listing.truncated) {
        onSettled(false);
        return;
      }
    }
    if (!cancelled) onSettled(true);
  })();
  return () => {
    cancelled = true;
  };
}
