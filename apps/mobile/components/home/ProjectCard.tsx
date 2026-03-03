import { Platform } from 'react-native'
import { View, Text, Pressable } from 'react-native'
import { Image } from 'react-native'
import { FolderOpen, Star, Check, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { ReactNode } from 'react'

// Deterministic accent colors for project cards (hex, matches template card style)
const PROJECT_ACCENT_COLORS = [
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f97316', // orange
  '#22c55e', // green
  '#06b6d4', // cyan
  '#7c3aed', // purple
  '#d946ef', // fuchsia
  '#14b8a6', // teal
]

export function getProjectAccentColor(name: string): string {
  const index =
    name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) %
    PROJECT_ACCENT_COLORS.length
  return PROJECT_ACCENT_COLORS[index]
}

export interface ProjectCardProps {
  name: string
  description?: string
  updatedAt?: string | number
  createdAt?: string | number
  thumbnailUrl?: string

  isDark?: boolean

  /** Outer card className overrides */
  className?: string

  // Overlay state
  isSelected?: boolean
  isStarred?: boolean
  selectMode?: boolean

  /** Small pill badge shown over the header (e.g. "Shared") */
  badge?: string

  // Callbacks
  onPress: () => void
  onLongPress?: () => void
  onStarToggle?: (e: any) => void
  onSelectToggle?: (e: any) => void

  /** Trailing slot in the info bar (e.g. action menu) */
  renderTrailing?: () => ReactNode
  /** Leading slot in the info bar (e.g. user avatar) */
  renderLeading?: () => ReactNode
}

export function ProjectCard({
  name,
  description,
  updatedAt,
  createdAt,
  thumbnailUrl,
  isDark = false,
  className,
  isSelected,
  isStarred,
  selectMode,
  badge,
  onPress,
  onLongPress,
  onStarToggle,
  onSelectToggle,
  renderTrailing,
  renderLeading,
}: ProjectCardProps) {
  const color = getProjectAccentColor(name)
  const initial = name?.charAt(0)?.toUpperCase() || 'P'

  const subtitle = description || (updatedAt
    ? `Edited ${formatDistanceAgo(updatedAt)}`
    : createdAt
      ? `Created ${formatDistanceAgo(createdAt)}`
      : null)

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      className={cn(
        'rounded-2xl overflow-hidden border border-border bg-card',
        isSelected && 'border-2 border-primary',
        className,
      )}
      style={Platform.OS === 'web' ? {
        boxShadow: isDark
          ? '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)'
          : '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.2s, transform 0.2s',
      } as any : {}}
    >
      {/* Header */}
      <View
        style={{
          height: 180,
          backgroundColor: isDark ? `${color}18` : `${color}0d`,
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }}
        className="items-center justify-center overflow-hidden"
      >
        {thumbnailUrl ? (
          <Image
            source={{ uri: thumbnailUrl }}
            className="absolute inset-0 w-full h-full"
            resizeMode="cover"
          />
        ) : (
          <View className="items-center justify-center gap-2">
            <FolderOpen size={32} style={{ color: `${color}99` }} />
            <Text
              style={{ color, fontSize: 11, fontWeight: '600', opacity: 0.7 }}
            >
              {initial}
            </Text>
          </View>
        )}

        {/* Select checkbox */}
        {selectMode && (
          <Pressable
            onPress={onSelectToggle}
            className="absolute top-1.5 left-1.5 p-1 z-10"
          >
            <View
              className={cn(
                'w-6 h-6 rounded border-2 items-center justify-center',
                isSelected
                  ? 'bg-primary border-primary'
                  : 'border-muted-foreground/40 bg-background/80',
              )}
            >
              {isSelected && <Check size={14} color="#fff" />}
            </View>
          </Pressable>
        )}

        {/* Star button */}
        {onStarToggle && (
          <Pressable
            onPress={onStarToggle}
            className={cn(
              'absolute top-2 right-2 p-1.5 rounded-md',
              isStarred ? 'bg-yellow-500/20' : 'bg-background/60',
            )}
          >
            <Star
              size={14}
              style={{ color: isStarred ? '#eab308' : undefined }}
              className={isStarred ? undefined : 'text-muted-foreground/50'}
              fill={isStarred ? '#eab308' : 'transparent'}
            />
          </Pressable>
        )}

        {/* Badge (e.g. "Shared") */}
        {badge && (
          <View className="absolute top-2 left-2 flex-row items-center bg-black/30 rounded-md px-2 py-0.5">
            <Users size={12} color="white" style={{ marginRight: 4 }} />
            <Text className="text-white text-xs">{badge}</Text>
          </View>
        )}
      </View>

      {/* Info */}
      <View className="px-4 py-3.5">
        <View className="flex-row items-center gap-2.5">
          {renderLeading?.()}
          <View className="flex-1 min-w-0">
            <Text
              className="font-semibold text-[15px] text-card-foreground"
              numberOfLines={1}
            >
              {name || 'Untitled'}
            </Text>
            {subtitle ? (
              <Text
                className="text-[13px] mt-0.5 leading-[18px] text-muted-foreground"
                numberOfLines={2}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
          {renderTrailing?.()}
        </View>
      </View>
    </Pressable>
  )
}

function formatDistanceAgo(timestamp: string | number): string {
  try {
    const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp)
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months}mo ago`
    return `${Math.floor(months / 12)}y ago`
  } catch {
    return ''
  }
}
