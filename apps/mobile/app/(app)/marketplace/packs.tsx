// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The built-in agent pack catalogue.
 *
 * Thirteen packs ship with the app (eight departments plus ops triage, daily
 * standup, meeting→cards, personal chief of staff and Self Evolving). Each is
 * an agent project plus the channels, boards and schedules it needs, and each
 * asks its own 2–4 questions through the same `PackInstallSheet` a listing's
 * pack uses. Nothing here is per-pack UI: the cards and the wizard render from
 * the catalogue payload.
 */

import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter } from 'expo-router'
import { ArrowLeft, CalendarClock, Hash, LayoutGrid, RefreshCw } from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { useActiveWorkspace } from '../../../hooks/useActiveWorkspace'
import { PackInstallSheet, type PackPreviewResponse, type PackQuestion } from '../../../components/marketplace'

interface PackCatalogEntry {
  id: string
  name: string
  description: string
  questions: PackQuestion[]
  channels: string[]
  schedules: Array<{ key: string; name: string; cron: string; enabled: boolean }>
}

export default observer(function PacksScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const activeWorkspace = useActiveWorkspace()
  const { width } = useWindowDimensions()
  const isWide = Platform.OS === 'web' && width >= 768

  const [packs, setPacks] = useState<PackCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PackCatalogEntry | null>(null)
  const [preview, setPreview] = useState<PackPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const loadPacks = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await http.get<{ packs: PackCatalogEntry[] }>('/api/marketplace/packs')
      setPacks(res.data?.packs ?? [])
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load packs')
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    void loadPacks()
  }, [loadPacks])

  const openPack = useCallback(
    async (pack: PackCatalogEntry) => {
      if (!activeWorkspace?.id) {
        Alert.alert('Workspace required', 'Pick a workspace before installing a pack.')
        return
      }
      setSelected(pack)
      setPreview(null)
      setInstallError(null)
      setPreviewLoading(true)
      try {
        const res = await http.get<PackPreviewResponse>(
          `/api/marketplace/packs/${encodeURIComponent(pack.id)}/install-preview?workspaceId=${encodeURIComponent(activeWorkspace.id)}`,
        )
        setPreview(res.data ?? null)
      } catch (err: any) {
        setInstallError(err?.message || 'Could not preview this pack')
      } finally {
        setPreviewLoading(false)
      }
    },
    [activeWorkspace?.id, http],
  )

  const install = useCallback(
    async (answers: Record<string, unknown>) => {
      if (!selected || !activeWorkspace?.id) return
      setInstalling(true)
      setInstallError(null)
      try {
        const res = await http.post<{ projectId: string | null; created: string[] }>(
          `/api/marketplace/packs/${encodeURIComponent(selected.id)}/install`,
          { workspaceId: activeWorkspace.id, answers },
        )
        setSelected(null)
        const created = res.data?.created?.length ?? 0
        const projectId = res.data?.projectId
        if (projectId) {
          router.push(`/(app)/projects/${projectId}` as any)
        } else {
          Alert.alert('Installed', `${created} thing${created === 1 ? '' : 's'} created.`)
        }
      } catch (err: any) {
        setInstallError(err?.message || 'Install failed')
      } finally {
        setInstalling(false)
      }
    },
    [activeWorkspace?.id, http, router, selected],
  )

  return (
    <View className="flex-1 bg-background">
      <View
        className={
          isWide
            ? 'border-b border-border/60 bg-background/95 px-6 py-4'
            : 'border-b border-border/60 bg-background px-4 py-3'
        }
      >
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} hitSlop={8} className="p-1 -ml-1" accessibilityRole="button" accessibilityLabel="Back to marketplace">
            <ArrowLeft size={18} color="#a1a1aa" />
          </Pressable>
          <View className="flex-1">
            {isWide && (
              <Text className="text-[11px] font-bold uppercase tracking-[1.2px] text-primary">Marketplace · Packs</Text>
            )}
            <Text className="text-lg font-semibold text-foreground">Agent packs</Text>
          </View>
          <Pressable onPress={() => void loadPacks()} hitSlop={8} className="p-1" accessibilityRole="button" accessibilityLabel="Reload packs">
            <RefreshCw size={16} color="#71717a" />
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
          {!!loadError && <Text className="text-red-500 text-sm">{loadError}</Text>}
          <Text className="text-muted-foreground text-xs">
            A pack installs an agent together with the channels, boards and schedules it works in. It brings its own
            setup questions, so you answer them once and it is ready.
          </Text>
          {packs.map((pack) => (
            <View key={pack.id} className="border border-border rounded-2xl p-4 bg-card">
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-foreground text-sm font-semibold">{pack.name}</Text>
                  <Text className="text-muted-foreground text-xs mt-1">{pack.description}</Text>
                </View>
                <Pressable
                  onPress={() => void openPack(pack)}
                  className="bg-primary rounded-lg px-3 py-2 active:opacity-80"
                  accessibilityRole="button"
                  accessibilityLabel={`Install ${pack.name}`}
                >
                  <Text className="text-primary-foreground text-xs font-semibold">Install</Text>
                </Pressable>
              </View>
              <View className="flex-row flex-wrap gap-x-3 gap-y-1 mt-3">
                {pack.channels.map((channel) => (
                  <View key={channel} className="flex-row items-center gap-1">
                    <Hash size={11} color="#71717a" />
                    <Text className="text-[11px] text-muted-foreground">{channel}</Text>
                  </View>
                ))}
                {pack.schedules.map((schedule) => (
                  <View key={schedule.key} className="flex-row items-center gap-1">
                    <CalendarClock size={11} color="#71717a" />
                    <Text className="text-[11px] text-muted-foreground">
                      {schedule.name}
                      {schedule.enabled ? '' : ' (off)'}
                    </Text>
                  </View>
                ))}
                <View className="flex-row items-center gap-1">
                  <LayoutGrid size={11} color="#71717a" />
                  <Text className="text-[11px] text-muted-foreground">{pack.questions.length} questions</Text>
                </View>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <PackInstallSheet
        visible={selected != null}
        packName={selected?.name ?? 'this pack'}
        preview={preview}
        loading={previewLoading}
        installing={installing}
        error={installError}
        onCancel={() => setSelected(null)}
        onInstall={(answers) => void install(answers)}
      />
    </View>
  )
})
