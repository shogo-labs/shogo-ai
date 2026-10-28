// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The huddle window on Shogo Desktop. Loaded by apps/desktop/src/huddle-window.ts
 * into a frameless, always-on-top window. It runs the LiveKit room (video
 * can't cross windows), mirrors the call state to the app window, and takes
 * commands from it. The window closes itself when the call ends.
 */
import { createElement, useEffect, useRef } from 'react'
import { Text, View } from 'react-native'
import { useAuth } from '../contexts/auth'
import { DomainProvider } from '../contexts/domain'
import { HuddleMiniCard, HuddlePanel } from '../components/team-chat/HuddleWindow'
import { getHuddleHostBridge, type DesktopHuddleHostBridge } from '../lib/desktop-huddle'
import { joinHuddleCall, runRemoteCommand, setHuddleView, snapshotForApp, useHuddleCall } from '../lib/huddle-call'

/** Where a frameless window can be dragged from; interactive controls stay clickable around it. */
function DragStrip({ expanded }: { expanded: boolean }) {
  return createElement('div', {
    'data-testid': 'huddle-drag-strip',
    style: {
      position: 'absolute',
      top: 0,
      left: expanded ? 40 : 96,
      right: expanded ? 128 : 76,
      height: expanded ? 48 : 30,
      zIndex: 60,
      WebkitAppRegion: 'drag',
    },
  })
}

function HuddleHost({ bridge }: { bridge: DesktopHuddleHostBridge }) {
  const call = useHuddleCall()
  const started = useRef(false)
  const closing = useRef(false)

  // Take calls and commands from the app window, then ask for the first call.
  useEffect(() => {
    const offJoin = bridge.onJoin((request) => {
      started.current = false
      closing.current = false
      void joinHuddleCall({ ...request, kind: request.kind as never })
    })
    const offCommand = bridge.onCommand((command) => runRemoteCommand(command as never))
    bridge.requestJoin()
    return () => {
      offJoin()
      offCommand()
    }
  }, [bridge])

  // Mirror the call to the app window, and close once it is over.
  useEffect(() => {
    if (call.status !== 'idle') started.current = true
    bridge.sendState(snapshotForApp())
    if (call.status === 'idle' && started.current && !closing.current) {
      closing.current = true
      bridge.close()
    }
  }, [bridge, call])

  // The window's size follows the view: the panel is large, everything else is the small card.
  const expanded = call.view === 'expanded'
  useEffect(() => {
    bridge.setMode(expanded ? 'expanded' : 'mini')
  }, [bridge, expanded])

  if (call.status === 'idle') {
    return (
      <View className="flex-1 items-center justify-center bg-background p-4">
        <Text className="text-sm text-muted-foreground">{call.error ?? 'Starting huddle…'}</Text>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background" testID="huddle-host">
      {expanded ? <HuddlePanel /> : <HuddleMiniCard onExpand={() => setHuddleView('expanded')} />}
      <DragStrip expanded={expanded} />
    </View>
  )
}

function HuddleHostGate({ bridge }: { bridge: DesktopHuddleHostBridge }) {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) return null
  if (!isAuthenticated) {
    return (
      <View className="flex-1 items-center justify-center bg-background p-4">
        <Text className="text-center text-sm text-muted-foreground" onPress={() => bridge.close()}>
          Sign in to Shogo to join huddles.
        </Text>
      </View>
    )
  }
  return (
    <DomainProvider>
      <HuddleHost bridge={bridge} />
    </DomainProvider>
  )
}

export default function HuddleRoute() {
  const bridge = getHuddleHostBridge()
  if (!bridge) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-sm text-muted-foreground">The huddle window only runs in Shogo Desktop.</Text>
      </View>
    )
  }
  return <HuddleHostGate bridge={bridge} />
}
