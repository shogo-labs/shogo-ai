// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Image,
  Modal,
} from 'react-native'
import { observer } from 'mobx-react-lite'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Package,
  Search,
  Trash2,
  X,
  ExternalLink,
  ArrowUpCircle,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'
import { getAccentColor, getInitial } from '../../../components/marketplace/accent'

function InstallIcon({ iconUrl, title, size = 36 }: { iconUrl: string | null; title: string; size?: number }) {
  const accent = getAccentColor(title)
  if (iconUrl) {
    return (
      <Image
        source={{ uri: iconUrl }}
        className="rounded-lg"
        style={{ width: size, height: size }}
        resizeMode="cover"
      />
    )
  }
  return (
    <View
      className="rounded-lg items-center justify-center"
      style={{ width: size, height: size, backgroundColor: `${accent}20` }}
    >
      <Text style={{ color: accent, fontSize: size * 0.4, fontWeight: '700' }}>
        {getInitial(title)}
      </Text>
    </View>
  )
}

interface InstallRow {
  id: string
  listingId: string
  projectId: string
  installedVersion: string
  installModel: 'fork' | 'linked'
  status: string
  listing: {
    id: string
    slug: string
    title: string
    iconUrl: string | null
    currentVersion: string
  }
}

interface UpdateState {
  hasUpdate: boolean
  installedVersion: string
  currentVersion: string
  changelog?: string
  drift?: { added: string[]; modified: string[]; deleted: string[] } | null
  loading: boolean
  applying: boolean
  error?: string | null
  appliedNotice?: string | null
}

export default observer(function InstallsScreen() {
  const router = useRouter()
  const http = useDomainHttp()
  const [installs, setInstalls] = useState<InstallRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [updateStates, setUpdateStates] = useState<Record<string, UpdateState>>({})
  const [uninstallTarget, setUninstallTarget] = useState<InstallRow | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  const loadInstalls = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await http.get<{ installs: InstallRow[] }>('/api/marketplace/my-installs')
      const items = res.data?.installs ?? []
      setInstalls(items)
      const next: Record<string, UpdateState> = {}
      for (const inst of items) {
        next[inst.id] = {
          hasUpdate: false,
          installedVersion: inst.installedVersion,
          currentVersion: inst.listing.currentVersion,
          loading: true,
          applying: false,
        }
      }
      setUpdateStates(next)
      await Promise.all(items.map((inst) => refreshOne(inst.id)))
    } catch (err) {
      console.error('[installs] load failed', err)
      const body = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data
      const msg =
        body?.code === 'cloud_signin_required'
          ? 'Sign in to Shogo Cloud to load installs, or restart the API after updating for local installs.'
          : typeof body?.error === 'string'
            ? body.error
            : 'Failed to load installs'
      setLoadError(msg)
      setInstalls([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [http])

  const refreshOne = useCallback(
    async (installId: string) => {
      try {
        const res = await http.get<{
          hasUpdate: boolean
          installedVersion: string
          currentVersion: string
          changelog?: string
          drift?: { added: string[]; modified: string[]; deleted: string[] }
        }>(`/api/marketplace/installs/${installId}/updates`)
        setUpdateStates((prev) => ({
          ...prev,
          [installId]: {
            ...prev[installId],
            ...res.data,
            loading: false,
            applying: false,
            error: null,
          },
        }))
      } catch (err) {
        console.error('[installs] check updates failed', err)
        setUpdateStates((prev) => ({
          ...prev,
          [installId]: {
            ...prev[installId],
            loading: false,
            applying: false,
            error: 'Failed to check for updates',
          },
        }))
      }
    },
    [http],
  )

  useEffect(() => {
    loadInstalls()
  }, [loadInstalls])

  const handleApply = useCallback(
    async (installId: string, force: boolean) => {
      setUpdateStates((prev) => ({
        ...prev,
        [installId]: { ...prev[installId], applying: true, error: null },
      }))
      try {
        const res = await http.post<
          | { ok: true; installedVersion: string; alreadyOnLatest?: boolean }
          | { error: string; diverged?: { added: string[]; modified: string[]; deleted: string[] } }
        >(`/api/marketplace/installs/${installId}/update`, { force })
        const data = res.data as
          | { ok: true; installedVersion: string }
          | { error: string; diverged?: { added: string[]; modified: string[]; deleted: string[] } }
        if ('ok' in data && data.ok) {
          setUpdateStates((prev) => ({
            ...prev,
            [installId]: {
              ...prev[installId],
              hasUpdate: false,
              installedVersion: data.installedVersion ?? prev[installId].installedVersion,
              applying: false,
              drift: null,
              appliedNotice: 'Updated successfully',
            },
          }))
          refreshOne(installId)
        } else {
          setUpdateStates((prev) => ({
            ...prev,
            [installId]: {
              ...prev[installId],
              applying: false,
              drift: data.diverged ?? prev[installId].drift,
              error:
                data.error === 'drift_detected'
                  ? 'Local changes detected. Force update to overwrite.'
                  : `Failed: ${data.error}`,
            },
          }))
        }
      } catch (err) {
        console.error('[installs] apply update failed', err)
        setUpdateStates((prev) => ({
          ...prev,
          [installId]: { ...prev[installId], applying: false, error: 'Update failed' },
        }))
      }
    },
    [http, refreshOne],
  )

  const handleUninstall = useCallback(async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await http.delete(`/api/marketplace/installs/${uninstallTarget.id}`)
      setInstalls((prev) => prev.filter((i) => i.id !== uninstallTarget.id))
      setUninstallTarget(null)
    } catch (err) {
      console.error('[installs] uninstall failed', err)
    } finally {
      setUninstalling(false)
    }
  }, [http, uninstallTarget])

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    loadInstalls()
  }, [loadInstalls])

  const sortedInstalls = useMemo(
    () =>
      [...installs].sort((a, b) => {
        const ua = updateStates[a.id]?.hasUpdate ? 0 : 1
        const ub = updateStates[b.id]?.hasUpdate ? 0 : 1
        if (ua !== ub) return ua - ub
        return a.listing.title.localeCompare(b.listing.title)
      }),
    [installs, updateStates],
  )

  const filteredInstalls = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sortedInstalls
    return sortedInstalls.filter((inst) => {
      const title = inst.listing.title.toLowerCase()
      const slug = inst.listing.slug.toLowerCase()
      return title.includes(q) || slug.includes(q)
    })
  }, [sortedInstalls, searchQuery])

  const updateCount = useMemo(
    () => sortedInstalls.filter((inst) => updateStates[inst.id]?.hasUpdate).length,
    [sortedInstalls, updateStates],
  )

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="px-5 pt-4 pb-3 gap-3">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} hitSlop={8} className="p-1 -ml-1">
            <ArrowLeft size={18} color="#a1a1aa" />
          </Pressable>
          <Text className="text-lg font-semibold text-foreground flex-1">Installed</Text>
          {updateCount > 0 && (
            <View className="px-2.5 py-1 rounded-md bg-blue-500/15">
              <Text className="text-[11px] font-semibold text-blue-500">
                {updateCount} update{updateCount !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>

        {!loadError && sortedInstalls.length > 0 && (
          <View className="flex-row items-center bg-muted/50 rounded-lg px-3 h-9">
            <Search size={14} color="#71717a" />
            <TextInput
              className="flex-1 ml-2 text-[13px] text-foreground web:outline-none no-focus-ring"
              placeholder="Filter installed agents…"
              placeholderTextColor="#71717a"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery('')} hitSlop={6}>
                <X size={13} color="#71717a" />
              </Pressable>
            )}
          </View>
        )}
      </View>

      <View className="h-px bg-border" />

      {/* Content */}
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {loadError && (
          <View className="rounded-xl bg-destructive/5 border border-destructive/20 px-4 py-5 gap-2">
            <Text className="text-[13px] font-medium text-destructive">Could not load installs</Text>
            <Text className="text-xs text-muted-foreground">{loadError}</Text>
            <Pressable onPress={onRefresh} className="mt-2 self-start px-3 py-1.5 rounded-md bg-primary">
              <Text className="text-[11px] font-semibold text-primary-foreground">Retry</Text>
            </Pressable>
          </View>
        )}

        {!loadError && sortedInstalls.length === 0 && (
          <View className="flex-1 items-center justify-center pt-20 gap-4">
            <View className="w-14 h-14 rounded-2xl bg-muted/60 items-center justify-center">
              <Package size={24} color="#71717a" />
            </View>
            <View className="items-center gap-1">
              <Text className="text-sm font-medium text-foreground">No agents installed</Text>
              <Text className="text-xs text-muted-foreground text-center px-8">
                Agents you install from the marketplace will appear here.
              </Text>
            </View>
            <Pressable
              onPress={() => router.push('/(app)/marketplace' as any)}
              className="mt-2 px-4 py-2 rounded-lg bg-primary active:opacity-80"
            >
              <Text className="text-xs font-semibold text-primary-foreground">Browse marketplace</Text>
            </Pressable>
          </View>
        )}

        {!loadError && sortedInstalls.length > 0 && filteredInstalls.length === 0 && (
          <View className="items-center pt-16 gap-2">
            <Search size={20} color="#71717a" />
            <Text className="text-sm text-muted-foreground">No matching agents</Text>
          </View>
        )}

        {filteredInstalls.map((inst) => {
          const state = updateStates[inst.id] ?? {
            hasUpdate: false,
            installedVersion: inst.installedVersion,
            currentVersion: inst.listing.currentVersion,
            loading: true,
            applying: false,
          }
          const drift = state.drift
          const driftCount = drift
            ? drift.added.length + drift.modified.length + drift.deleted.length
            : 0

          return (
            <View
              key={inst.id}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
              {/* Top row: icon + title + badge */}
              <View className="flex-row items-center px-4 pt-4 pb-2 gap-3">
                <InstallIcon iconUrl={inst.listing.iconUrl} title={inst.listing.title} />

                <View className="flex-1 min-w-0">
                  <Text className="text-[13px] font-semibold text-foreground" numberOfLines={1}>
                    {inst.listing.title}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    v{state.installedVersion}
                    {inst.installModel === 'linked' ? ' · Linked' : ''}
                  </Text>
                </View>

                {/* Status badge with text */}
                {state.loading && (
                  <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
                    <ActivityIndicator size={10} />
                    <Text className="text-[10px] text-muted-foreground">Checking</Text>
                  </View>
                )}
                {!state.loading && state.hasUpdate && (
                  <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/10">
                    <ArrowUpCircle size={12} color="#3b82f6" />
                    <Text className="text-[10px] font-semibold text-blue-500">Update available</Text>
                  </View>
                )}
                {!state.loading && !state.hasUpdate && driftCount > 0 && (
                  <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10">
                    <AlertTriangle size={12} color="#d97706" />
                    <Text className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">Modified</Text>
                  </View>
                )}
                {!state.loading && !state.hasUpdate && driftCount === 0 && (
                  <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/10">
                    <CheckCircle2 size={12} color="#22c55e" />
                    <Text className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">Up to date</Text>
                  </View>
                )}
              </View>

              {/* Changelog (shown when update available) */}
              {state.changelog && state.hasUpdate && (
                <View className="mx-4 mb-2 rounded-md bg-muted/30 px-3 py-2">
                  <Text className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wide">
                    What's new
                  </Text>
                  <Text className="text-[11px] text-foreground/80 mt-1 leading-4">
                    {state.changelog}
                  </Text>
                </View>
              )}

              {/* Drift details */}
              {driftCount > 0 && (
                <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-md bg-amber-500/5 border border-amber-500/15 px-3 py-2">
                  <AlertTriangle size={11} color="#d97706" />
                  <Text className="text-[11px] text-muted-foreground flex-1">
                    {drift!.modified.length} modified · {drift!.added.length} added · {drift!.deleted.length} removed
                  </Text>
                </View>
              )}

              {/* Error / success messages */}
              {state.error && (
                <Text className="text-[11px] text-destructive px-4 mb-2">{state.error}</Text>
              )}
              {state.appliedNotice && (
                <View className="flex-row items-center gap-1.5 px-4 mb-2">
                  <CheckCircle2 size={11} color="#16a34a" />
                  <Text className="text-[11px] text-emerald-600">{state.appliedNotice}</Text>
                </View>
              )}

              {/* Actions bar */}
              <View className="flex-row items-center px-4 py-3 border-t border-border/50 gap-2">
                {state.hasUpdate && (
                  <Pressable
                    onPress={() => handleApply(inst.id, false)}
                    disabled={state.applying}
                    className={cn(
                      'flex-row items-center gap-1.5 px-3 py-1.5 rounded-md',
                      state.applying ? 'bg-primary/30' : 'bg-primary active:opacity-80',
                    )}
                  >
                    {state.applying ? (
                      <ActivityIndicator size={10} color="#fff" />
                    ) : (
                      <RefreshCw size={11} color="#fff" />
                    )}
                    <Text className="text-[11px] font-semibold text-primary-foreground">Update</Text>
                  </Pressable>
                )}
                {state.hasUpdate && driftCount > 0 && (
                  <Pressable
                    onPress={() => handleApply(inst.id, true)}
                    disabled={state.applying}
                    className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md border border-amber-500/30 active:opacity-80"
                  >
                    <AlertTriangle size={10} color="#d97706" />
                    <Text className="text-[11px] font-medium text-amber-700 dark:text-amber-400">Force update</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => router.push(`/(app)/projects/${inst.projectId}` as any)}
                  className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md border border-border active:opacity-80"
                >
                  <ExternalLink size={10} color="#71717a" />
                  <Text className="text-[11px] font-medium text-muted-foreground">Open</Text>
                </Pressable>
                <View className="flex-1" />
                <Pressable
                  onPress={() => setUninstallTarget(inst)}
                  hitSlop={6}
                  className="flex-row items-center gap-1.5 px-2.5 py-1.5 rounded-md active:bg-destructive/10"
                >
                  <Trash2 size={12} color="#dc2626" />
                  <Text className="text-[11px] font-medium text-destructive">Uninstall</Text>
                </Pressable>
              </View>
            </View>
          )
        })}
      </ScrollView>

      {/* Uninstall confirmation modal */}
      <Modal
        visible={!!uninstallTarget}
        transparent
        animationType="fade"
        onRequestClose={() => !uninstalling && setUninstallTarget(null)}
      >
        <Pressable
          onPress={() => !uninstalling && setUninstallTarget(null)}
          className="flex-1 bg-black/60 items-center justify-center px-6"
        >
          <Pressable className="w-full max-w-sm rounded-xl bg-card border border-border overflow-hidden">
            <View className="p-5 gap-3">
              <View className="flex-row items-center gap-3">
                {uninstallTarget && (
                  <InstallIcon iconUrl={uninstallTarget.listing.iconUrl} title={uninstallTarget.listing.title} size={32} />
                )}
                <Text className="text-[15px] font-semibold text-foreground flex-1">
                  Uninstall {uninstallTarget?.listing.title}?
                </Text>
              </View>
              <Text className="text-[13px] text-muted-foreground leading-5">
                This will permanently delete the project files. If you have a subscription, it will cancel at the end of the current billing period.
              </Text>
            </View>
            <View className="flex-row border-t border-border">
              <Pressable
                onPress={() => setUninstallTarget(null)}
                disabled={uninstalling}
                className="flex-1 items-center py-3 active:bg-muted/40 border-r border-border"
              >
                <Text className="text-[13px] font-medium text-muted-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleUninstall}
                disabled={uninstalling}
                className="flex-1 flex-row items-center justify-center gap-2 py-3 active:bg-destructive/10"
              >
                {uninstalling && <ActivityIndicator size={12} color="#dc2626" />}
                <Text className="text-[13px] font-medium text-destructive">
                  {uninstalling ? 'Removing…' : 'Uninstall'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
})
