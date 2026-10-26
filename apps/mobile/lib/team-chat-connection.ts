// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform wiring for `TeamChatConnection`: one ref-counted connection per
 * workspace, authenticated like the rest of the app (cookies on web, the
 * Better Auth cookie header on native), with presence following app focus.
 */
import { useEffect, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { createAuthedEventSource } from './authed-event-source'
import { nativeCookieHeader, realtimeUrls, type TeamChatEvent } from './team-chat-api'
import { TeamChatConnection, type RealtimeState } from './team-chat-realtime'
import { useActiveInstance } from '../contexts/active-instance'

type MachineRoute = { instanceId: string; localWorkspaceId: string } | null

const connections = new Map<string, { connection: TeamChatConnection; refs: number; stopPresence: () => void }>()

/** One connection per workspace *and* machine: the same workspace id means two
 *  different event streams when one of them is a paired desktop's own. */
function connectionKey(workspaceId: string, machine: MachineRoute): string {
  return machine ? `${workspaceId}::${machine.instanceId}/${machine.localWorkspaceId}` : workspaceId
}

function createSocket(url: string) {
  if (Platform.OS === 'web') return new WebSocket(url) as any
  const WS = WebSocket as unknown as new (url: string, protocols?: string[] | null, options?: { headers?: Record<string, string> }) => any
  return new WS(url, null, { headers: nativeCookieHeader() })
}

function watchPresence(connection: TeamChatConnection): () => void {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
    // An unfocused window counts as away, so a browser left open behind other
    // apps doesn't stop phone pushes.
    let focused = document.hasFocus()
    const update = () => connection.setPresence(focused && document.visibilityState !== 'hidden' ? 'active' : 'away')
    const onFocus = () => {
      focused = true
      update()
    }
    const onBlur = () => {
      focused = false
      update()
    }
    update()
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }
  const sub = AppState.addEventListener('change', (state) => connection.setPresence(state === 'active' ? 'active' : 'away'))
  return () => sub.remove()
}

export function acquireTeamChatConnection(
  workspaceId: string,
  machine: MachineRoute = null,
): { connection: TeamChatConnection; release: () => void } {
  const key = connectionKey(workspaceId, machine)
  let entry = connections.get(key)
  if (!entry) {
    const connection = new TeamChatConnection({
      urls: realtimeUrls(workspaceId, machine),
      createSocket,
      createEventSource: (url) => createAuthedEventSource(url) as any,
    })
    connection.start()
    entry = { connection, refs: 0, stopPresence: watchPresence(connection) }
    connections.set(key, entry)
  }
  entry.refs++
  let released = false
  return {
    connection: entry.connection,
    release: () => {
      if (released) return
      released = true
      const current = connections.get(key)
      if (!current) return
      current.refs--
      if (current.refs > 0) return
      current.stopPresence()
      current.connection.stop()
      connections.delete(key)
    },
  }
}

/** Subscribe to team chat events for a workspace while mounted. */
export function useTeamChatEvents(workspaceId: string | null | undefined, onEvent: (event: TeamChatEvent) => void): RealtimeState {
  const { instance } = useActiveInstance()
  const machineInstanceId = instance?.source === 'machine' ? (instance.instanceId ?? null) : null
  const machineLocalWorkspaceId = instance?.source === 'machine' ? (instance.localWorkspaceId ?? null) : null
  const [state, setState] = useState<RealtimeState>('closed')
  const onEventRef = useLatest(onEvent)
  useEffect(() => {
    if (!workspaceId) return
    const machine: MachineRoute =
      machineInstanceId && machineLocalWorkspaceId
        ? { instanceId: machineInstanceId, localWorkspaceId: machineLocalWorkspaceId }
        : null
    const { connection, release } = acquireTeamChatConnection(workspaceId, machine)
    setState(connection.state)
    const offState = connection.onState(setState)
    const offEvents = connection.on((event) => onEventRef.current(event))
    return () => {
      offEvents()
      offState()
      release()
    }
  }, [workspaceId, machineInstanceId, machineLocalWorkspaceId])
  return state
}

export function sendTyping(workspaceId: string, conversationId: string, threadRootId: string | null = null): void {
  connections.get(workspaceId)?.connection.sendTyping(conversationId, threadRootId)
}

function useLatest<T>(value: T): { current: T } {
  const [ref] = useState(() => ({ current: value }))
  ref.current = value
  return ref
}
