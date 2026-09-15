// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Manage Slack projects" — the searchable, groupable project list for the
 * Shogo Agent for Slack card in Settings → Integrations.
 *
 * Replaces the old flat "every project gets an inline Switch" list, which
 * doesn't scale past a handful of projects (no search, no grouping, and
 * required manually opting in each project one at a time). Projects are
 * now Slack-enabled by default (see `Project.slackEnabled`'s schema
 * default) — this UI is for the exception case of disabling specific
 * projects, or auditing/bulk-toggling a large workspace.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  ActivityIndicator,
  Switch,
  type ListRenderItemInfo,
} from 'react-native'
import { Search as SearchIcon, X as XIcon, CheckCircle2 as CheckCircle2Icon } from 'lucide-react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'
import { cn } from '@shogo/shared-ui/primitives'

export interface SlackProjectRow {
  id: string
  name: string
  description?: string | null
  slackEnabled: boolean
  createdBy?: string | null
}

type Scope = 'all' | 'mine'

interface SlackProjectsModalProps {
  visible: boolean
  onClose: () => void
  projects: SlackProjectRow[]
  currentUserId?: string | null
  onToggle: (projectId: string, enabled: boolean) => void
  onBulkToggle: (projectIds: string[], enabled: boolean) => void
  savingProjectId?: string | null
  bulkSaving?: boolean
  /**
   * Shows a green "your Slack account is linked" banner above the search
   * bar. Set when this modal was auto-opened right after the
   * `/auth/slack-link` bridge page completed a fresh account link, so the
   * user gets unambiguous confirmation it worked instead of just landing
   * on a settings page that looks the same as always.
   */
  justLinked?: boolean
}

export function SlackProjectsModal({
  visible,
  onClose,
  projects,
  currentUserId,
  onToggle,
  onBulkToggle,
  savingProjectId,
  bulkSaving,
  justLinked,
}: SlackProjectsModalProps) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')

  const mineCount = useMemo(
    () => (currentUserId ? projects.filter((p) => p.createdBy === currentUserId).length : 0),
    [projects, currentUserId],
  )

  const scoped = useMemo(() => {
    if (scope === 'mine' && currentUserId) {
      return projects.filter((p) => p.createdBy === currentUserId)
    }
    return projects
  }, [projects, scope, currentUserId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q),
    )
  }, [scoped, query])

  const enabledCount = useMemo(() => filtered.filter((p) => p.slackEnabled).length, [filtered])
  const isFiltered = query.trim().length > 0 || scope === 'mine'

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SlackProjectRow>) => {
      const saving = savingProjectId === item.id
      return (
        <View className="flex-row items-center gap-3 px-1 py-2.5 border-b border-border">
          <View className="flex-1 min-w-0">
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {item.name}
            </Text>
            {item.description ? (
              <Text className="text-[11px] text-muted-foreground mt-0.5" numberOfLines={1}>
                {item.description}
              </Text>
            ) : null}
          </View>
          {saving ? (
            <ActivityIndicator size="small" />
          ) : (
            <Switch value={item.slackEnabled} onValueChange={(value) => onToggle(item.id, value)} />
          )}
        </View>
      )
    },
    [onToggle, savingProjectId],
  )

  return (
    <Modal isOpen={visible} onClose={onClose} size="lg">
      <ModalBackdrop />
      <ModalContent className="max-h-[85%]">
        <ModalHeader>
          <Text className="text-base font-semibold text-foreground">Manage Slack projects</Text>
          <ModalCloseButton>
            <XIcon size={16} className="text-muted-foreground" />
          </ModalCloseButton>
        </ModalHeader>

        <ModalBody contentContainerClassName="gap-3">
          {justLinked && (
            <View className="flex-row items-start gap-2 px-3 py-2.5 rounded-md border border-green-500/30 bg-green-500/10">
              <CheckCircle2Icon size={16} className="text-green-600 mt-0.5" />
              <View className="flex-1">
                <Text className="text-xs font-medium text-foreground">
                  Your Slack account is linked
                </Text>
                <Text className="text-[11px] text-muted-foreground mt-0.5">
                  Choose which projects Shogo can access from Slack below. Everything is
                  enabled by default — you only need to change anything if you want to
                  restrict access.
                </Text>
              </View>
            </View>
          )}

          {/* Search */}
          <View className="flex-row items-center gap-2 px-3 py-2 rounded-md border border-border">
            <SearchIcon size={14} className="text-muted-foreground" />
            <TextInput
              className="flex-1 text-sm text-foreground"
              style={{ outlineStyle: 'none' } as any}
              placeholder="Search projects…"
              placeholderTextColor="rgb(115 115 115)"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} className="p-0.5">
                <XIcon size={12} className="text-muted-foreground" />
              </Pressable>
            )}
          </View>

          {/* Scope + live count */}
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={() => setScope('all')}
              className={cn(
                'px-3 py-1.5 rounded-full border',
                scope === 'all' ? 'bg-primary border-primary' : 'border-border',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  scope === 'all' ? 'text-primary-foreground' : 'text-foreground',
                )}
              >
                All projects ({projects.length})
              </Text>
            </Pressable>
            {!!currentUserId && (
              <Pressable
                onPress={() => setScope('mine')}
                className={cn(
                  'px-3 py-1.5 rounded-full border',
                  scope === 'mine' ? 'bg-primary border-primary' : 'border-border',
                )}
              >
                <Text
                  className={cn(
                    'text-xs font-medium',
                    scope === 'mine' ? 'text-primary-foreground' : 'text-foreground',
                  )}
                >
                  My projects ({mineCount})
                </Text>
              </Pressable>
            )}
            <View className="flex-1" />
            <Text className="text-xs text-muted-foreground">
              {enabledCount}/{filtered.length} enabled
            </Text>
          </View>

          {/* Bulk actions — scoped to whatever is currently visible, so
              "Enable all" after a search only touches the matched rows. */}
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={() => onBulkToggle(filtered.map((p) => p.id), true)}
              disabled={bulkSaving || filtered.length === 0}
              className="px-3 py-1.5 border border-border rounded-md active:bg-muted"
              style={bulkSaving || filtered.length === 0 ? { opacity: 0.5 } : undefined}
            >
              <Text className="text-xs text-foreground">
                Enable {isFiltered ? 'shown' : 'all'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onBulkToggle(filtered.map((p) => p.id), false)}
              disabled={bulkSaving || filtered.length === 0}
              className="px-3 py-1.5 border border-border rounded-md active:bg-muted"
              style={bulkSaving || filtered.length === 0 ? { opacity: 0.5 } : undefined}
            >
              <Text className="text-xs text-foreground">
                Disable {isFiltered ? 'shown' : 'all'}
              </Text>
            </Pressable>
            {bulkSaving && <ActivityIndicator size="small" />}
          </View>

          {/* List — FlatList (not ScrollView+map) so this stays smooth
              whether a workspace has 10 projects or 10,000. */}
          {filtered.length === 0 ? (
            <View className="items-center py-10">
              <Text className="text-sm text-muted-foreground">
                {query ? `No projects match "${query}".` : 'No projects yet.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              style={{ maxHeight: 420 }}
              initialNumToRender={25}
              windowSize={10}
              removeClippedSubviews
              keyboardShouldPersistTaps="handled"
            />
          )}
        </ModalBody>

        <ModalFooter>
          <Pressable
            onPress={onClose}
            className="px-4 py-2 bg-primary rounded-md active:bg-primary/80 ml-auto"
          >
            <Text className="text-sm text-primary-foreground">Done</Text>
          </Pressable>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
