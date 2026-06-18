// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// useScmRefreshPolicy — single place that coordinates the SCM viewlet's
// background refresh cadences instead of scattering several `setInterval`
// effects across the component:
//
//   - status  (~5s):   cheap working-tree status refresh
//   - graph   (~30s):  status + commit-history refresh
//   - remote  (~180s): remote fetch to keep ahead/behind counts fresh
//                      (only when an upstream is configured)
//
// Backoff: while the user is composing a commit message (`isTyping`) every
// cadence is paused so a refresh-driven re-render can't disrupt the textarea.
// `isTyping` is read through a ref so toggling it does NOT tear down and rebuild
// the intervals on every keystroke.

import { useEffect, useRef } from "react";

export interface ScmRefreshPolicyOptions {
  /** Master switch (auto-refresh on + a workspace is open). */
  enabled: boolean;
  /** Whether a remote upstream exists (gates the remote-fetch cadence). */
  hasUpstream: boolean;
  /** Pause all cadences while the user is actively composing a commit. */
  isTyping: boolean;
  /** Cheap status-only refresh. */
  onStatusRefresh: () => void;
  /** Status + commit-history refresh. */
  onGraphRefresh: () => void;
  /** Remote fetch (skipped when `hasUpstream` is false). */
  onRemoteFetch?: () => void;
  statusIntervalMs?: number;
  graphIntervalMs?: number;
  remoteIntervalMs?: number;
}

export function useScmRefreshPolicy({
  enabled,
  hasUpstream,
  isTyping,
  onStatusRefresh,
  onGraphRefresh,
  onRemoteFetch,
  statusIntervalMs = 5_000,
  graphIntervalMs = 30_000,
  remoteIntervalMs = 180_000,
}: ScmRefreshPolicyOptions): void {
  const isTypingRef = useRef(isTyping);
  isTypingRef.current = isTyping;

  const statusRef = useRef(onStatusRefresh);
  statusRef.current = onStatusRefresh;
  const graphRef = useRef(onGraphRefresh);
  graphRef.current = onGraphRefresh;
  const remoteRef = useRef(onRemoteFetch);
  remoteRef.current = onRemoteFetch;

  useEffect(() => {
    if (!enabled) return;

    const gate = (fn: () => void) => () => {
      if (!isTypingRef.current) fn();
    };

    // Kick the remote cadence once on enable so counts populate without waiting
    // a full interval (matches the previous immediate auto-fetch behavior).
    if (hasUpstream && !isTypingRef.current) remoteRef.current?.();

    const ids: ReturnType<typeof setInterval>[] = [
      setInterval(gate(() => statusRef.current()), statusIntervalMs),
      setInterval(gate(() => graphRef.current()), graphIntervalMs),
    ];
    if (hasUpstream) {
      ids.push(setInterval(gate(() => remoteRef.current?.()), remoteIntervalMs));
    }

    return () => {
      for (const id of ids) clearInterval(id);
    };
  }, [enabled, hasUpstream, statusIntervalMs, graphIntervalMs, remoteIntervalMs]);
}
