// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The user-facing address of a project's preview.
 *
 * A runtime URL (`http://<metal-host-ip>:<port>`, a pod DNS name, a localhost
 * port) is internal plumbing: only this API uses it to reach the runtime. The
 * address a person opens is the project's `*.preview.<base>` origin, which the
 * preview-router Worker proxies to wherever the runtime lives (on metal, the
 * hosting region is pinned in the Worker's KV — see `rememberPreviewRegion`).
 *
 * Metal learning the hard way (SHO-322): a prod user was handed
 * `http://103.219.171.29:20011/p/<id>/…` — a box's public DNAT address on an
 * internal port — because these routes returned the resolved runtime origin.
 */

/**
 * `https://<id>.preview.<base>/p/<id>/`, or `null` when this deployment has no
 * preview domain (local / desktop), where the runtime URL *is* the user's URL.
 */
export async function projectPreviewUrl(projectId: string): Promise<string | null> {
  if (!process.env.PREVIEW_BASE_DOMAIN) return null
  // Imported lazily: `knative-project-manager` pulls in the cluster stack,
  // which the slim desktop composer must not bundle.
  const { getPreviewUrl } = await import('./knative-project-manager')
  return `${getPreviewUrl(projectId)}/p/${projectId}/`
}
