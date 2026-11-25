// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The 503 body for a failed repo export, and the `code` the host decides from.
 *
 * A CORRUPT repository gets its own code (`repo-corrupt`) rather than
 * `lfs-push-failed`: the host must not treat it as a transient push failure and
 * retry, because the same objects are missing next time. Retrying it re-exported
 * and re-quarantined 525 MB every ten minutes for six days (SHO-584); the host
 * blocks rotation on this code instead.
 *
 * Lives in its own module with no side effects — `server.ts` boots the runtime
 * and refuses to load without `PROJECT_ID`, so importing it just to check the
 * body shape made the contract untestable (and turned CI red).
 */

import type { LfsPushError } from '@shogo/shared-runtime'

export interface LfsPushFailureBody {
  error: string
  code: 'repo-corrupt' | 'lfs-push-failed'
  reason: LfsPushError['reason']
  stderr: string
  missing: LfsPushError['missing']
}

export function lfsPushFailureBody(err: LfsPushError): LfsPushFailureBody {
  const corrupt = err.reason === 'repo-corrupt'
  return {
    error: `lfs push failed (${err.reason}): ${err.message}`,
    code: corrupt ? 'repo-corrupt' : 'lfs-push-failed',
    reason: err.reason,
    stderr: err.stderr.slice(0, 16_000),
    missing: err.missing,
  }
}
