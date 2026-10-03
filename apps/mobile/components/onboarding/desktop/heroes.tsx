// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Small illustrations for the desktop permission steps, composed from
 * existing icons and rounded shapes (no external artwork).
 */
import type { ComponentType } from 'react'
import { Text, View } from 'react-native'
import {
  AudioLines,
  FileText,
  Folder,
  Mail,
  MessageCircle,
  MousePointer2,
  NotebookText,
  Table2,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

type IconType = ComponentType<{ size?: number; className?: string }>

export function ComputerUseHero() {
  return (
    <View testID="hero-computer-use" className="h-28 w-56 items-center justify-center" accessibilityElementsHidden>
      <View className="absolute left-0 top-4 h-20 w-28 -rotate-6 rounded-xl border border-border bg-card" />
      <View className="absolute right-0 top-4 h-20 w-28 rotate-6 rounded-xl border border-border bg-card" />
      <View className="h-24 w-36 items-center justify-center rounded-xl border-2 border-primary bg-background">
        <View className="absolute left-3 right-3 top-3 gap-1.5">
          <View className="h-1.5 w-3/4 rounded-full bg-muted" />
          <View className="h-1.5 w-1/2 rounded-full bg-muted" />
          <View className="h-1.5 w-2/3 rounded-full bg-muted" />
        </View>
        <MousePointer2 size={28} className="text-foreground" />
      </View>
    </View>
  )
}

function Tile({ icon: Icon, className }: { icon: IconType; className?: string }) {
  return (
    <View className={cn('h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card', className)}>
      <Icon size={26} className="text-foreground" />
    </View>
  )
}

export function FilesAppsHero() {
  const tiles: { icon: IconType; className?: string }[] = [
    { icon: Folder, className: '-rotate-12 mt-3' },
    { icon: Table2, className: '-rotate-6' },
    { icon: MessageCircle },
    { icon: NotebookText, className: 'rotate-6' },
    { icon: FileText, className: 'rotate-12 mt-3' },
    { icon: Mail, className: 'rotate-[16deg] mt-6' },
  ]
  return (
    <View testID="hero-files-apps" className="flex-row items-start justify-center gap-2" accessibilityElementsHidden>
      {tiles.map((t, i) => (
        <Tile key={i} icon={t.icon} className={t.className} />
      ))}
    </View>
  )
}

export function DictationHero() {
  return (
    <View testID="hero-dictation" className="h-28 w-52 items-center justify-center" accessibilityElementsHidden>
      <View className="h-24 w-32 rounded-2xl border border-border bg-card p-3">
        <View className="gap-1.5">
          <View className="h-1.5 w-full rounded-full bg-muted" />
          <View className="h-1.5 w-4/5 rounded-full bg-muted" />
          <View className="h-1.5 w-3/5 rounded-full bg-muted" />
        </View>
      </View>
      <View className="absolute right-0 top-8 flex-row items-center gap-1.5 rounded-full border border-border bg-background px-3 py-2">
        <AudioLines size={20} className="text-primary" />
        <Text className="text-xs font-medium text-foreground">Listening</Text>
      </View>
    </View>
  )
}
