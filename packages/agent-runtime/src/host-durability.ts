// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Metal guests set `SHOGO_DURABILITY_HOST_MEDIATED`: the host hydrates source
 * before the runtime sees it and exports it on suspend. These guests hold no
 * object-store credentials (only bucket names), so they must never run their
 * own S3 sync.
 */
export function isHostMediatedDurability(): boolean {
  const v = process.env.SHOGO_DURABILITY_HOST_MEDIATED
  return v === '1' || v === 'true'
}
