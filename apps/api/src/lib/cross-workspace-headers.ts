// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The header names both sides of a cross-workspace call read.
 *
 * Their own module, with nothing else in it, because the cloud-only forwarder
 * (`cross-workspace-host.ts`) needs them and importing `cross-workspace.ts`
 * there would pull the forwarder back in through a cycle.
 */

/**
 * The person a forwarded cross-workspace call was made for (SHO-389).
 *
 * A desktop that relays a call to a cloud workspace has already proved who it
 * is for — it holds the person's ticket and their owned Personal workspace, and
 * it spends the approval. The cloud cannot re-verify that ticket (different
 * signing secret), so the desktop names the person in two headers instead. They
 * are only believed when the caller authenticated with a **workspace device
 * key** (the `Authorization: Bearer shogo_sk_…` a signed-in desktop uses) *and*
 * names a Personal workspace that person actually owns — so a runtime token,
 * which an agent can read, cannot use them to impersonate anybody.
 */
export const CROSS_WORKSPACE_REQUESTER_HEADER = 'X-Cross-Workspace-Requester'

/** The tool the runtime gated, carried across the call for the audit line. */
export const CROSS_WORKSPACE_TOOL_HEADER = 'X-Cross-Workspace-Tool'

/**
 * The cloud half of a workspace hosted on a paired desktop (SHO-493).
 *
 * A hosted workspace's boards, cards and chat live in **that desktop's
 * SQLite**, so answering the call from Postgres would give wrong or empty
 * answers. The call is forwarded over the host's instance tunnel instead, to
 * the same `/api/internal/workspaces/<id>/…` path on the desktop's local API.
 *
 * `X-Cross-Workspace-Hosted-From` is what marks such a request on the desktop
 * side. It names the Personal workspace the person was acting in. It grants
 * nothing on its own: the tunnel-stamped user, the desktop holding the
 * workspace and a membership check against that SQLite are all still required
 * (see `hostedForward`).
 */
export const CROSS_WORKSPACE_HOSTED_FROM_HEADER = 'X-Cross-Workspace-Hosted-From'
