// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Text } from 'react-native'
import { Star } from 'lucide-react-native'

interface ReviewCardProps {
  rating: number
  title?: string | null
  body?: string | null
  createdAt: string
  userName?: string
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function ReviewCard({ rating, title, body, createdAt, userName }: ReviewCardProps) {
  return (
    <View className="p-3 rounded-lg border border-border bg-card gap-2">
      <View className="flex-row items-center justify-between">
        <View className="flex-row gap-0.5">
          {[1, 2, 3, 4, 5].map((s) => (
            <Star
              key={s}
              size={14}
              className={s <= rating ? 'text-yellow-500' : 'text-muted-foreground/30'}
              fill={s <= rating ? 'currentColor' : 'none'}
            />
          ))}
        </View>
        <Text className="text-xs text-muted-foreground">{timeAgo(createdAt)}</Text>
      </View>

      {userName && (
        <Text className="text-xs text-muted-foreground">{userName}</Text>
      )}

      {title && (
        <Text className="text-sm font-medium text-foreground">{title}</Text>
      )}

      {body && (
        <Text className="text-sm text-muted-foreground leading-5">{body}</Text>
      )}
    </View>
  )
}
