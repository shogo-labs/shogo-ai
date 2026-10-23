// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An image shared into a conversation: the preview itself.
 *
 * The preview is sized to the image *and* to the space the message got — a wide
 * screenshot fills the pane up to `CHAT_IMAGE_MAX_WIDTH` instead of sitting in a
 * fixed 220px box, while a tall photo stops at `CHAT_IMAGE_MAX_HEIGHT` and keeps
 * its aspect ratio. Older attachments carry no dimensions, so the natural size
 * is taken from the image once it loads and the box is fitted again.
 */

import { useState } from 'react'
import { Image } from 'react-native'
import { fitChatImage } from '../chat/turns/image-sizing'

export interface ChatImageAttachmentProps {
  /** Absolute URL of the stored image. */
  url: string
  /** File name as uploaded, used as the image's accessible label. */
  name: string
  /** Dimensions recorded at upload, when this build stored them. */
  naturalWidth?: number | null
  naturalHeight?: number | null
  /** Width of the row the image sits in, from `useMeasuredWidth`. */
  containerWidth?: number | null
}

export function ChatImageAttachment({
  url,
  name,
  naturalWidth,
  naturalHeight,
  containerWidth,
}: ChatImageAttachmentProps) {
  const [loaded, setLoaded] = useState<{ width: number; height: number } | null>(null)
  const box = fitChatImage({
    naturalWidth: naturalWidth ?? loaded?.width,
    naturalHeight: naturalHeight ?? loaded?.height,
    containerWidth,
  })
  // Stored dimensions win; the image's own only fill the gap they leave.
  const needsNaturalSize = !(naturalWidth && naturalHeight)

  return (
    <Image
      source={{ uri: url }}
      className="rounded-lg border border-border"
      style={{ width: box.width, height: box.height }}
      // The box matches the image's aspect unless the min width had to widen a
      // very tall one, which is the only case that crops.
      resizeMode={box.cropped ? 'cover' : 'contain'}
      onLoad={(event) => {
        if (!needsNaturalSize) return
        const source = event.nativeEvent?.source
        if (source?.width && source?.height) {
          setLoaded({ width: source.width, height: source.height })
        }
      }}
      accessibilityLabel={name}
    />
  )
}
