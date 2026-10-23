// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** The call you're in, with its people merged into tiles. Shared by every huddle surface (window, pill, mini card, picture-in-picture). */
import { useMemo } from 'react'
import { useHuddleCall } from '../lib/huddle-call'
import { buildRoster, type RosterEntry } from '../lib/huddle-roster'
import type { Huddle } from '../lib/team-chat-api'
import { useConversationHuddle } from './useHuddles'
import { useMyUserId } from './useTeamChat'

export function useHuddleRoster() {
  const call = useHuddleCall()
  const me = useMyUserId()
  const { huddle } = useConversationHuddle(call.workspaceId, call.conversationId)
  const roster: RosterEntry[] = useMemo(
    () => buildRoster({ participants: call.participants, huddle, video: call.video, speaking: call.speaking, me }),
    [call.participants, huddle, call.video, call.speaking, me],
  )
  return { call, huddle: huddle as Huddle | null, me, roster, canModerate: !!me && huddle?.startedById === me }
}
