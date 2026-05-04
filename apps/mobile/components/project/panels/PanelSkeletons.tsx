// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View } from 'react-native'
import { Skeleton } from '@shogo/shared-ui/primitives'

/**
 * Content-aware loading skeletons for project panels.
 * Each variant mirrors the real layout of its panel so the user
 * sees a stable shape while data loads (no layout shift).
 */

export function ProjectShellSkeleton() {
  return (
    <View className="flex-1 bg-background">
      {/* Top bar */}
      <View className="h-12 border-b border-border px-4 flex-row items-center gap-3">
        <Skeleton className="h-5 w-5 rounded-md" />
        <Skeleton className="h-4 w-40 rounded-md" />
        <View className="flex-1" />
        <Skeleton className="h-6 w-20 rounded-md" />
      </View>
      {/* Body */}
      <View className="flex-1 flex-row">
        {/* Chat column skeleton */}
        <View className="w-[480px] border-r border-border p-4 gap-4">
          <View className="gap-3">
            <Skeleton className="h-4 w-3/4 rounded-md" />
            <Skeleton className="h-4 w-1/2 rounded-md" />
          </View>
          <View className="gap-3 mt-4">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-4/5 rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </View>
          <View className="flex-1" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </View>
        {/* Canvas column skeleton */}
        <View className="flex-1 p-4 gap-4">
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="flex-1 rounded-2xl" />
        </View>
      </View>
    </View>
  )
}

export function FileTreeSkeleton() {
  return (
    <View className="p-2 gap-1.5">
      <Skeleton className="h-3 w-20 rounded-sm" />
      {[1, 0.85, 0.7, 0.9, 0.6, 0.75, 0.8].map((w, i) => (
        <View key={i} className="flex-row items-center gap-2 py-1 pl-2">
          <Skeleton className="h-3 w-3 rounded-sm" />
          <Skeleton className="h-3 rounded-sm" style={{ width: `${w * 60}%` }} />
        </View>
      ))}
    </View>
  )
}

export function FileContentSkeleton() {
  return (
    <View className="flex-1 p-4 gap-2">
      {[0.9, 0.7, 0.85, 0.6, 0.95, 0.5, 0.8, 0.65, 0.75, 0.4].map((w, i) => (
        <Skeleton key={i} className="h-3.5 rounded-sm" style={{ width: `${w * 100}%` }} />
      ))}
    </View>
  )
}

export function ChannelsSkeleton() {
  return (
    <View className="gap-2">
      {[1, 2, 3, 4].map((i) => (
        <View key={i} className="border border-border rounded-lg p-3 gap-2">
          <View className="flex-row items-center gap-2.5">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <View className="flex-1 gap-1.5">
              <Skeleton className="h-4 w-32 rounded-md" />
              <Skeleton className="h-3 w-48 rounded-sm" />
            </View>
            <Skeleton className="h-5 w-16 rounded-full" />
          </View>
        </View>
      ))}
    </View>
  )
}

export function CheckpointsSkeleton() {
  return (
    <View className="flex-1 p-4 gap-3">
      {[1, 2, 3].map((i) => (
        <View key={i} className="border border-border rounded-lg p-3 gap-2">
          <View className="flex-row items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-40 rounded-md" />
            <View className="flex-1" />
            <Skeleton className="h-3 w-20 rounded-sm" />
          </View>
          <Skeleton className="h-3 w-3/4 rounded-sm" />
        </View>
      ))}
    </View>
  )
}

export function SkillsSkeleton() {
  return (
    <View className="gap-3">
      {[1, 2, 3].map((i) => (
        <View key={i} className="border border-border rounded-lg p-3 gap-2">
          <View className="flex-row items-center gap-2">
            <Skeleton className="h-5 w-5 rounded-md" />
            <Skeleton className="h-4 w-36 rounded-md" />
          </View>
          <Skeleton className="h-3 w-full rounded-sm" />
          <Skeleton className="h-3 w-2/3 rounded-sm" />
        </View>
      ))}
    </View>
  )
}

export function StatusSkeleton() {
  return (
    <View className="gap-4">
      {/* Stats row */}
      <View className="flex-row flex-wrap gap-3">
        {[1, 2, 3, 4].map((i) => (
          <View key={i} className="flex-1 min-w-[100px] border border-border rounded-lg p-3 gap-2">
            <View className="flex-row items-center gap-2">
              <Skeleton className="h-4 w-4 rounded-md" />
              <Skeleton className="h-3 w-16 rounded-sm" />
            </View>
            <Skeleton className="h-5 w-20 rounded-md" />
          </View>
        ))}
      </View>
      {/* Sections */}
      {[1, 2].map((i) => (
        <View key={i} className="border border-border rounded-lg p-3 gap-2">
          <Skeleton className="h-4 w-28 rounded-md" />
          <Skeleton className="h-3 w-full rounded-sm" />
          <Skeleton className="h-3 w-3/4 rounded-sm" />
        </View>
      ))}
    </View>
  )
}

export function PlansSkeleton() {
  return (
    <View className="gap-2 p-4">
      {[1, 2, 3].map((i) => (
        <View key={i} className="border border-border rounded-lg px-4 py-3 gap-2">
          <Skeleton className="h-4 w-48 rounded-md" />
          <Skeleton className="h-3 w-full rounded-sm" />
          <View className="flex-row items-center gap-2 mt-1">
            <Skeleton className="h-3 w-16 rounded-sm" />
            <Skeleton className="h-3 w-24 rounded-sm" />
          </View>
        </View>
      ))}
    </View>
  )
}

export function AgentsSkeleton() {
  return (
    <View className="p-4 gap-3">
      {/* Tab bar placeholder */}
      <View className="flex-row gap-2 mb-1">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-md" />
        ))}
      </View>
      {/* Activity cards */}
      {[1, 2, 3].map((i) => (
        <View key={i} className="border border-border rounded-lg p-3 gap-2">
          <View className="flex-row items-center gap-2">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-32 rounded-md" />
            <View className="flex-1" />
            <Skeleton className="h-3 w-12 rounded-sm" />
          </View>
          <Skeleton className="h-3 w-full rounded-sm" />
          <Skeleton className="h-3 w-2/3 rounded-sm" />
        </View>
      ))}
    </View>
  )
}

export function LogsSkeleton() {
  return (
    <View className="flex-1 p-2 gap-0.5">
      {[0.95, 0.7, 0.85, 0.6, 0.9, 0.75, 0.5, 0.8, 0.65, 0.88, 0.72, 0.55].map((w, i) => (
        <View key={i} className="flex-row items-center gap-2 px-2 py-1">
          <Skeleton className="h-3 w-14 rounded-sm" />
          <Skeleton className="h-2.5 w-8 rounded-sm" />
          <Skeleton className="h-3 rounded-sm" style={{ width: `${w * 60}%` }} />
        </View>
      ))}
    </View>
  )
}

export function CapabilitiesSkeleton() {
  return (
    <View className="p-4 gap-4">
      {/* Model selector */}
      <View className="border border-border rounded-lg p-3 gap-2">
        <Skeleton className="h-4 w-24 rounded-md" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </View>
      {/* Toggle rows */}
      {[1, 2, 3, 4, 5].map((i) => (
        <View key={i} className="flex-row items-center justify-between py-2">
          <View className="flex-row items-center gap-3">
            <Skeleton className="h-5 w-5 rounded-md" />
            <View className="gap-1">
              <Skeleton className="h-4 w-28 rounded-md" />
              <Skeleton className="h-3 w-44 rounded-sm" />
            </View>
          </View>
          <Skeleton className="h-6 w-10 rounded-full" />
        </View>
      ))}
    </View>
  )
}
