// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The one place that decides which container image a published runtime runs.
 *
 * The ksvc builder and the `PublishedDeployment` row must never disagree: if
 * they do, `rollback` and `redeploy` patch the service to an image other than
 * the one that was recorded, and `promote` can ship something nobody built.
 * Precedence is: an explicit per-publish image (a per-commit build, §2), then
 * the deployment-wide override, then the runtime default.
 */

import { RUNTIME_CONFIG } from '@shogo/shared-runtime'

export function resolvePublishedRuntimeImage(explicit?: string | null): string {
  const chosen = explicit?.trim() || process.env.PUBLISHED_RUNTIME_IMAGE?.trim() || RUNTIME_CONFIG.image()
  return chosen
}
