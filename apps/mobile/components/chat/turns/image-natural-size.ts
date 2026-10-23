// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from "react"

export interface NaturalImageSize {
  width: number
  height: number
}

/**
 * The pixel size an image reports when it loads.
 *
 * Native hands it over as `nativeEvent.source`; react-native-web forwards the
 * bare DOM load event instead, whose `target` is the loader's own `<img>` and
 * carries `naturalWidth`/`naturalHeight`. Reading both is what makes the fit
 * rule work on web, desktop and native alike.
 */
export function imageSizeFromLoadEvent(event: unknown): NaturalImageSize | null {
  const outer = event as { nativeEvent?: unknown; target?: unknown } | null
  const native = outer?.nativeEvent as
    | { source?: { width?: number; height?: number }; target?: unknown }
    | undefined
  const target = (native?.target ?? outer?.target) as
    | { naturalWidth?: number; naturalHeight?: number }
    | undefined
  const width = native?.source?.width ?? target?.naturalWidth
  const height = native?.source?.height ?? target?.naturalHeight
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width, height }
    : null
}

/**
 * The natural size of `uri`, for surfaces that have to fit a box before the
 * image has painted. `knownWidth`/`knownHeight` (dimensions stored with the
 * attachment) win over anything the load reports.
 */
export function useNaturalImageSize(
  uri: string | null | undefined,
  knownWidth?: number | null,
  knownHeight?: number | null,
) {
  const [loaded, setLoaded] = useState<(NaturalImageSize & { uri: string | null | undefined }) | null>(
    null,
  )
  const onLoad = useCallback(
    (event: unknown) => {
      // Nothing to learn when the attachment already carries its size.
      if (knownWidth && knownHeight) return
      const size = imageSizeFromLoadEvent(event)
      if (!size) return
      setLoaded((prev) =>
        prev && prev.uri === uri && prev.width === size.width && prev.height === size.height
          ? prev
          : { ...size, uri },
      )
    },
    [knownWidth, knownHeight, uri],
  )
  const size: NaturalImageSize | null =
    knownWidth && knownHeight
      ? { width: knownWidth, height: knownHeight }
      : loaded && loaded.uri === uri
        ? { width: loaded.width, height: loaded.height }
        : null
  return { size, onLoad }
}
