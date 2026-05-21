// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useCallback } from 'react'
import { Pressable, Text, Alert } from 'react-native'
import { UserPlus, UserCheck } from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { useDomainHttp } from '../../contexts/domain'

interface FollowCreatorButtonProps {
  creatorId: string
  initialFollowing: boolean
  followerCount: number
  onToggle?: (following: boolean, newCount: number) => void
  size?: 'sm' | 'md'
}

export function FollowCreatorButton({
  creatorId,
  initialFollowing,
  followerCount,
  onToggle,
  size = 'md',
}: FollowCreatorButtonProps) {
  const { user } = useAuth()
  const http = useDomainHttp()
  const [following, setFollowing] = useState(initialFollowing)
  const [count, setCount] = useState(followerCount)
  const [loading, setLoading] = useState(false)

  const handlePress = useCallback(async () => {
    if (!user?.id) {
      Alert.alert('Sign In Required', 'You need to be signed in to follow creators.')
      return
    }
    const wasFollowing = following
    const prevCount = count

    // Optimistic update
    setFollowing(!wasFollowing)
    setCount(wasFollowing ? Math.max(0, prevCount - 1) : prevCount + 1)

    setLoading(true)
    try {
      const res = wasFollowing
        ? await http.delete<{ ok: boolean; followerCount: number }>(
            `/api/marketplace/creators/${creatorId}/follow`,
          )
        : await http.post<{ ok: boolean; followerCount: number }>(
            `/api/marketplace/creators/${creatorId}/follow`,
          )
      const serverCount = res.data.followerCount
      setCount(serverCount)
      setFollowing(!wasFollowing)
      onToggle?.(!wasFollowing, serverCount)
    } catch {
      // Revert on failure
      setFollowing(wasFollowing)
      setCount(prevCount)
    } finally {
      setLoading(false)
    }
  }, [user?.id, following, count, creatorId, http, onToggle])

  const isSmall = size === 'sm'
  const iconSize = isSmall ? 12 : 14
  const Icon = following ? UserCheck : UserPlus

  return (
    <Pressable
      onPress={handlePress}
      disabled={loading}
      className={`flex-row items-center gap-1.5 rounded-xl px-4 py-2 active:opacity-80 ${
        following
          ? 'bg-primary/15 border border-primary/30'
          : 'bg-foreground/10'
      } ${isSmall ? 'px-3 py-1.5' : ''} ${loading ? 'opacity-60' : ''}`}
    >
      <Icon
        size={iconSize}
        color={following ? '#7c3aed' : '#71717a'}
      />
      <Text
        className={`font-semibold ${
          following ? 'text-primary' : 'text-foreground'
        } ${isSmall ? 'text-[11px]' : 'text-xs'}`}
      >
        {following ? 'Following' : 'Follow'}
      </Text>
    </Pressable>
  )
}
