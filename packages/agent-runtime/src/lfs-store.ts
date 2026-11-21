// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The runtime's one object store handle.
 *
 * Two callers share it — serving LFS media on request (`dist-response.ts`) and
 * writing large media plus the publish artifact (`publish-endpoints.ts`) — and
 * they must agree on the bucket and the client, so it is resolved once. Null
 * when this runtime has no object storage configured (desktop, a bare local
 * run), which every caller treats as "fall back to what is on disk".
 */

import { lfsObjectStoreFromEnv, type LfsObjectStore } from '@shogo/shared-runtime'

let resolved: LfsObjectStore | null | undefined

export function lfsObjectStore(): LfsObjectStore | null {
  if (resolved === undefined) resolved = lfsObjectStoreFromEnv()
  return resolved
}
