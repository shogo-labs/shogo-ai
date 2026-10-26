// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pixel size of an image, for surfaces that have to fit a box before the
 * image has painted.
 *
 * Two sources, because no single one works everywhere:
 *
 * - `Image.getSize` is the portable answer. On web react-native-web polls a
 *   retained `<img>` it owns, so it keeps working after the load event's
 *   dispatch has finished.
 * - The load event is the cheap answer on native, which hands over
 *   `nativeEvent.source`. react-native-web also forwards the DOM load event,
 *   but it defers the callback through `image.decode()` and Chromium has
 *   nulled `target` (and `composedPath()`) by then, so on web that event
 *   carries nothing usable — which is why `getSize` is not optional.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Image } from "react-native"

export interface NaturalImageSize {
  width: number
  height: number
}

/**
 * The pixel size a load event reports, when the platform includes it.
 *
 * Native nests it in `nativeEvent.source`; a DOM event carries it as
 * `target.naturalWidth`/`naturalHeight` as long as the event is read while it
 * is still being dispatched.
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

function isUsable(size: NaturalImageSize | null): size is NaturalImageSize {
  return !!size && size.width > 0 && size.height > 0
}

/**
 * Natural size of `uri`. Dimensions stored with the attachment
 * (`knownWidth`/`knownHeight`) win over anything measured here.
 */
export function useNaturalImageSize(
  uri: string | null | undefined,
  knownWidth?: number | null,
  knownHeight?: number | null,
) {
  const [measured, setMeasured] = useState<
    (NaturalImageSize & { uri: string | null | undefined }) | null
  >(null)
  // A late measurement for an image that is no longer shown must not resize
  // whatever took its place.
  const currentUri = useRef(uri)
  currentUri.current = uri
  // `getSize` has no cancel, so ask once per image rather than once per render.
  const requested = useRef<string | null>(null)
  const known = Boolean(knownWidth && knownHeight)

  const remember = useCallback(
    (size: NaturalImageSize, forUri: string) =>
      setMeasured((prev) =>
        prev && prev.uri === forUri && prev.width === size.width && prev.height === size.height
          ? prev
          : { ...size, uri: forUri },
      ),
    [],
  )

  useEffect(() => {
    if (!uri || known) return
    if (measured && measured.uri === uri) return
    if (requested.current === uri) return
    const getSize = (Image as { getSize?: unknown }).getSize
    if (typeof getSize !== "function") return
    requested.current = uri
    ;(getSize as (u: string, ok: (w: number, h: number) => void, fail?: () => void) => void).call(
      Image,
      uri,
      (width: number, height: number) => {
        if (currentUri.current !== uri) return
        const size = { width, height }
        if (isUsable(size)) remember(size, uri)
      },
      () => {},
    )
  }, [uri, known, measured, remember])

  const onLoad = useCallback(
    (event: unknown) => {
      if (!uri || known) return
      const size = imageSizeFromLoadEvent(event)
      if (!isUsable(size)) return
      remember(size, uri)
    },
    [uri, known, remember],
  )

  const size: NaturalImageSize | null =
    knownWidth && knownHeight
      ? { width: knownWidth, height: knownHeight }
      : measured && measured.uri === uri
        ? { width: measured.width, height: measured.height }
        : null

  return { size, onLoad }
}
