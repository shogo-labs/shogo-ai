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

const connections = new Map<string, { connection: TeamChatConnection; refs: number; stopPresence: () => void }>()

function createSocket(url: string) {
  if (Platform.OS === 'web') return new WebSocket(url) as any
  const WS = WebSocket as unknown as new (url: string, protocols?: string[] | null, options?: { headers?: Record<string, string> }) => any
  return new WS(url, null, { headers: nativeCookieHeader() })
}

function watchPresence(connection: TeamChatConnection): () => void {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') return () => {}
    const onVisibility = () => connection.setPresence(document.visibilityState === 'hidden' ? 'away' : 'active')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }
  const sub = AppState.addEventListener('change', (state) => connection.setPresence(state === 'active' ? 'active' : 'away'))
  return () => sub.remove()
}

export function acquireTeamChatConnection(workspaceId: string): { connection: TeamChatConnection; release: () => void } {
  let entry = connections.get(workspaceId)
  if (!entry) {
    const connection = new TeamChatConnection({
      urls: realtimeUrls(workspaceId),
      createSocket,
      createEventSource: (url) => createAuthedEventSource(url) as any,
    })
    connection.start()
    entry = { connection, refs: 0, stopPresence: watchPresence(connection) }
    connections.set(workspaceId, entry)
  }
  entry.refs++
  let released = false
  return {
    connection: entry.connection,
    release: () => {
      if (released) return
      released = true
      const current = connections.get(workspaceId)
      if (!current) return
      current.refs--
      if (current.refs > 0) return
      current.stopPresence()
      current.connection.stop()
      connections.delete(workspaceId)
    },
  }
}

/** Subscribe to team chat events for a workspace while mounted. */
export function useTeamChatEvents(workspaceId: string | null | undefined, onEvent: (event: TeamChatEvent) => void): RealtimeState {
  const [state, setState] = useState<RealtimeState>('closed')
  const onEventRef = useLatest(onEvent)
  useEffect(() => {
    if (!workspaceId) return
    const { connection, release } = acquireTeamChatConnection(workspaceId)
    setState(connection.state)
    const offState = connection.onState(setState)
    const offEvents = connection.on((event) => onEventRef.current(event))
    return () => {
      offEvents()
      offState()
      release()
    }
  }, [workspaceId])
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
