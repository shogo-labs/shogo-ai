// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one hidden Shogo buddy renderer behind every agent avatar on native.
 * Mount it once near the app root; it draws each requested look in turn and
 * hands the picture back to `lib/buddy-snapshots`. Renders nothing on web,
 * where avatars draw their own canvas.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { Platform, View } from 'react-native'
import { BUDDY_WEBVIEW_HTML } from '../island/buddy/buddy-webview.generated'
import {
  SNAPSHOT_BODY_SIZE,
  nextSnapshotRequest,
  resolveSnapshot,
  snapshotVersion,
  subscribeSnapshots,
} from '../../lib/buddy-snapshots'

const HEIGHT = Math.round(SNAPSHOT_BODY_SIZE * 1.4)
/** A draw that never answers shouldn't wedge the queue. */
const DRAW_TIMEOUT_MS = 4000

export function BuddySnapshotHost() {
  if (Platform.OS === 'web') return null
  return <NativeHost />
}

function NativeHost() {
  const WebView = require('react-native-webview').default
  const ref = useRef<any>(null)
  const ready = useRef(false)
  const inFlight = useRef<string | null>(null)
  const version = useSyncExternalStore(subscribeSnapshots, snapshotVersion, snapshotVersion)

  const pump = useCallback(() => {
    if (!ready.current || inFlight.current) return
    const next = nextSnapshotRequest()
    if (!next) return
    inFlight.current = next.key
    const props = JSON.stringify({ size: SNAPSHOT_BODY_SIZE, color: next.color, look: next.look })
    ref.current?.injectJavaScript(
      `window.__shogoBuddySnapshot && window.__shogoBuddySnapshot(${JSON.stringify(next.key)}, ${props});true;`,
    )
    const key = next.key
    setTimeout(() => {
      if (inFlight.current !== key) return
      inFlight.current = null
      resolveSnapshot(key, null)
    }, DRAW_TIMEOUT_MS)
  }, [])

  useEffect(() => {
    pump()
  }, [pump, version])

  const onMessage = useCallback(
    (event: { nativeEvent?: { data?: string } }) => {
      try {
        const message = JSON.parse(event.nativeEvent?.data ?? '')
        if (message?.type === 'ready') {
          ready.current = true
          pump()
        } else if (message?.type === 'snapshot' && typeof message.id === 'string') {
          if (inFlight.current === message.id) inFlight.current = null
          resolveSnapshot(message.id, typeof message.dataUrl === 'string' ? message.dataUrl : null)
        }
      } catch {
        // Not a bridge message.
      }
    },
    [pump],
  )

  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: SNAPSHOT_BODY_SIZE, height: HEIGHT, opacity: 0.01 }}>
      <WebView
        ref={ref}
        source={{ html: BUDDY_WEBVIEW_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled={false}
        style={{ width: SNAPSHOT_BODY_SIZE, height: HEIGHT, backgroundColor: 'transparent' }}
        containerStyle={{ width: SNAPSHOT_BODY_SIZE, height: HEIGHT }}
        onMessage={onMessage}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      />
    </View>
  )
}
