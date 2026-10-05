// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** One huddle camera or screen track, rendered into a <video> element (web and Electron). */
import { createElement, useEffect, useRef } from 'react'
import type { HuddleVideoTile } from '../../lib/huddle-call'

export function HuddleVideo({ tile, fit }: { tile: HuddleVideoTile; fit: 'cover' | 'contain' }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    tile.track.attach(el)
    return () => {
      tile.track.detach(el)
    }
  }, [tile.track])
  return createElement('video', {
    ref,
    autoPlay: true,
    playsInline: true,
    muted: true,
    'data-testid': `huddle-video-${tile.source}`,
    style: {
      width: '100%',
      height: '100%',
      objectFit: fit,
      backgroundColor: '#000',
      // Mirror your own camera, like a mirror; never mirror a screen.
      transform: tile.isLocal && tile.source === 'camera' ? 'scaleX(-1)' : undefined,
    },
  })
}
