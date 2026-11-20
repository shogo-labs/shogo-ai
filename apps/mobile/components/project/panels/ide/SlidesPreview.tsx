// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A PowerPoint deck, rendered as real slides in a sandboxed frame (SHO-426).
 *
 * Thin wrapper around `OfficePreview` with `kind="slides"`. All the shared
 * iframe + message logic lives in `OfficePreview`; this file exists so that
 * `FilePreview.tsx` can lazy-import just the slides component via a stable
 * path, and so existing tests that import `SlidesPreview` directly continue
 * to work without change.
 *
 * Web only. On iOS and Android `FileContentView` mounts `NativeOffice`.
 */

import { OfficePreview } from './OfficePreview'

export { isSlidesPath } from './slides-viewer-protocol'

export function SlidesPreview({
  url,
  name,
  path,
  onError,
}: {
  url: string
  name: string
  path: string
  onError?: (message: string) => void
}) {
  return <OfficePreview kind="slides" url={url} name={name} path={path} onError={onError} />
}
