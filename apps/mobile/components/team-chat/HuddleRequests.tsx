// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "X wants to join": people who opened the huddle link and are waiting at the
 * door. Everyone in the call sees these with Admit and Deny; the first answer
 * wins. Guests are labelled so nobody lets in a stranger by accident.
 */
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { admitHuddleRequest, denyHuddleRequest } from '../../lib/huddle-call'
import type { HuddleJoinRequest } from '../../lib/team-chat-api'
import { UserAvatar } from './UserAvatar'

function RequestRow({ request, compact }: { request: HuddleJoinRequest; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const answer = async (admit: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      await (admit ? admitHuddleRequest(request.id) : denyHuddleRequest(request.id))
    } finally {
      setBusy(false)
    }
  }
  return (
    <View className={cn('flex-row items-center gap-2', compact ? 'px-2 py-1' : 'rounded-lg bg-muted px-3 py-2')} testID={`huddle-request-${request.id}`}>
      {compact ? null : <UserAvatar name={request.name} image={request.image} size={28} />}
      <View className="min-w-0 flex-1">
        <Text className={cn('font-medium', compact ? 'text-[11px] text-white' : 'text-sm text-foreground')} numberOfLines={1}>
          {request.name} wants to join
        </Text>
        {request.guest && !compact ? <Text className="text-[11px] text-muted-foreground">Guest · not in your workspace</Text> : null}
      </View>
      <Pressable
        disabled={busy}
        onPress={() => void answer(false)}
        accessibilityRole="button"
        accessibilityLabel={`Deny ${request.name}`}
        className={cn('rounded-md border px-2.5 py-1 active:opacity-70', compact ? 'border-white/40' : 'border-border')}
      >
        <Text className={cn('text-xs font-medium', compact ? 'text-white' : 'text-foreground')}>Deny</Text>
      </Pressable>
      <Pressable
        disabled={busy}
        onPress={() => void answer(true)}
        accessibilityRole="button"
        accessibilityLabel={`Admit ${request.name}`}
        className="rounded-md bg-emerald-600 px-2.5 py-1 active:opacity-80"
      >
        <Text className="text-xs font-medium text-white">Admit</Text>
      </Pressable>
    </View>
  )
}

/** The list shown above the stage in the expanded call. */
export function HuddleRequests({ requests }: { requests: HuddleJoinRequest[] | undefined }) {
  if (!requests?.length) return null
  return (
    <View className="gap-1.5 px-3 pt-2" testID="huddle-requests">
      {requests.map((r) => (
        <RequestRow key={r.id} request={r} />
      ))}
    </View>
  )
}

/** One request at a time over the mini card, with a count when more are waiting. */
export function HuddleRequestStrip({ requests }: { requests: HuddleJoinRequest[] | undefined }) {
  if (!requests?.length) return null
  return (
    <View className="absolute inset-x-0 bottom-0 bg-black/75" testID="huddle-request-strip">
      <RequestRow request={requests[0]!} compact />
      {requests.length > 1 ? <Text className="px-2 pb-1 text-[10px] text-zinc-300">+{requests.length - 1} more waiting</Text> : null}
    </View>
  )
}
