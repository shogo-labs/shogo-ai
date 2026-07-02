// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canonical product token for the Shogo worker CLI, e.g. `shogo-cli/1.2.3`.
 *
 * Sent as the `User-Agent` on every request the worker makes to Shogo Cloud
 * (heartbeat, tunnel WebSocket, device login). Without it, Node/Bun `fetch`
 * emits a generic runtime User-Agent (or none), which is indistinguishable
 * from arbitrary bot traffic at the CDN edge — a problem for headless
 * cloud/datacenter deployments where the source ASN already looks like
 * "Hosting" to bot-management heuristics (see issue #783). A stable,
 * self-identifying UA lets the edge scope bot-mitigation exceptions to
 * genuine worker traffic instead of relying on IP allowlists.
 *
 * `__SHOGO_WORKER_VERSION__` is injected by bundlers via
 * `--define '__SHOGO_WORKER_VERSION__="x.y.z"'`. The `typeof` guard returns
 * `'undefined'` without throwing when the identifier was never defined
 * (standalone library consumers), in which case we fall back to a purely
 * diagnostic `unknown` tag.
 */
declare const __SHOGO_WORKER_VERSION__: string | undefined;

export function workerUserAgent(): string {
  if (typeof __SHOGO_WORKER_VERSION__ === 'string' && __SHOGO_WORKER_VERSION__.length > 0) {
    return `shogo-cli/${__SHOGO_WORKER_VERSION__}`;
  }
  return 'shogo-cli/unknown';
}
