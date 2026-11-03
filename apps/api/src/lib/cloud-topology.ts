// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure, env-only probes for "what kind of deployment is this API process?".
 *
 * Kept in its own module (no prisma, no OTel, no runtime imports) so the
 * runtime resolvers can call it on every request without pulling a heavy
 * module onto the cold path — the same reason `metal-eligibility.ts` exists.
 */

/**
 * Whether this API process can resolve a workspace hosted on a paired desktop
 * (SHO-285).
 *
 * The boundary is local mode, not the cluster: a desktop's own API
 * (`SHOGO_LOCAL_MODE`) serves its workspace from its own database and must
 * never ask, while a cloud API reaches the desktop over the instance tunnel —
 * whether it runs in Kubernetes, in a metal region, or as a single host (the
 * two-process e2e is a cloud API with neither cluster nor metal). Gating on
 * `KUBERNETES_SERVICE_HOST` silently turned the whole feature off anywhere
 * else. The lookup itself is one indexed read, cached for
 * `HOST_TTL_MS` (see `host-tunnel`), and answers `null` for an ordinary cloud
 * workspace.
 */
export function hostedWorkspacesResolveHere(): boolean {
  return process.env.SHOGO_LOCAL_MODE !== 'true'
}
