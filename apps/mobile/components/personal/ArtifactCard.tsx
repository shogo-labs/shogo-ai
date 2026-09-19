// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A single deliverable produced while working a goal — a link, a file, or a
 * hidden builder project (see `Project.hidden`) the companion built for
 * you. Rendered in chat (as a tool-result card), Goal Detail, and Activity,
 * so this is the one definition of what a "deliverable" looks like.
 */
import { Linking, Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ExternalLink, File as FileIcon, FolderKanban } from 'lucide-react-native'
import type { PersonalGoalDeliverable as GoalDeliverable } from '../../lib/api'

const ICONS = {
  url: ExternalLink,
  file: FileIcon,
  project: FolderKanban,
} as const

const LABELS = {
  url: 'Link',
  file: 'File',
  project: 'Project',
} as const

export function ArtifactCard({ deliverable }: { deliverable: GoalDeliverable }) {
  const router = useRouter()
  const type = deliverable.type ?? 'url'
  const Icon = ICONS[type]

  const open = () => {
    if (type === 'project' && deliverable.projectId) {
      router.push({ pathname: '/(app)/projects/[id]', params: { id: deliverable.projectId } } as any)
      return
    }
    if (deliverable.url) {
      void Linking.openURL(deliverable.url).catch(() => undefined)
    }
  }

  const openable = Boolean((type === 'project' && deliverable.projectId) || deliverable.url)

  const Container = openable ? Pressable : View
  return (
    <Container
      {...(openable ? { onPress: open, accessibilityRole: 'button' as const } : {})}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3.5 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
        <Icon size={18} className="text-primary" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {deliverable.title || LABELS[type]}
        </Text>
        {deliverable.description ? (
          <Text className="mt-0.5 text-xs leading-4 text-muted-foreground" numberOfLines={2}>
            {deliverable.description}
          </Text>
        ) : deliverable.url ? (
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {deliverable.url}
          </Text>
        ) : null}
      </View>
      {openable ? <ExternalLink size={15} className="text-muted-foreground" /> : null}
    </Container>
  )
}

export function ArtifactCardList({ deliverables }: { deliverables: GoalDeliverable[] }) {
  if (deliverables.length === 0) return null
  return (
    <View className="gap-2">
      {deliverables.map((d, i) => (
        <ArtifactCard key={`${d.type}-${d.url ?? d.projectId ?? i}`} deliverable={d} />
      ))}
    </View>
  )
}
