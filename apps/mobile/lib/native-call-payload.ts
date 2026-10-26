// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reads an incoming huddle ring from a push's data. Pure, so the phone's call
 * module and its background task can share it.
 */
import type { NativeCallRing } from './native-call'

/** Reads a ring from a push payload (VoIP keys, or data keys on Android). Null if it isn't a ring. */
export function ringFromPushData(data: Record<string, unknown>): NativeCallRing | null {
  const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  const huddleId = str(data.huddleId)
  const conversationId = str(data.conversationId)
  const workspaceId = str(data.workspaceId)
  if (!huddleId || !conversationId || !workspaceId) return null
  const from = (data.from ?? null) as { userId?: unknown; name?: unknown; image?: unknown } | null
  return {
    huddleId,
    conversationId,
    workspaceId,
    kind: data.kind === 'group_dm' ? 'group_dm' : 'dm',
    from: {
      userId: str(from?.userId) ?? str(data.callerId) ?? '',
      name: str(from?.name) ?? str(data.callerName) ?? 'Someone',
      image: str(from?.image) ?? null,
    },
  }
}
