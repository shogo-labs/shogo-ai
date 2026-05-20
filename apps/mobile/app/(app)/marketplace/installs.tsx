// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phase 8 — installed marketplace agents screen.
 *
 * Lists every install owned by the current user, with:
 * - Update available badge when listing.currentVersion !== installedVersion
 * - Drift indicator when the on-disk workspace diverges from the
 *   baseline manifest captured at last install/update
 * - "Apply update" button (no-drift path)
 * - "Force update — overwrites your changes" button (drift path)
 *
 * This pairs with the API rewrite in
 * apps/api/src/services/marketplace-install.service.ts (checkForUpdates
 * + applyUpdate({ force })) shipped in Phase 6.
 */

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
  X,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'
import { getAccentColor, getInitial } from '../../../components/marketplace/accent'

const INSTALL_MODEL_LABELS: Record<'fork' | 'linked', string> = {
  fork: 'Independent copy',
  linked: 'Linked to publisher',
}

function InstallListingIcon({
  iconUrl,
  title,
}: {
  iconUrl: string | null
  title: string
}) {
  const accent = getAccentColor(title)
  if (iconUrl) {
    return (
      <Image
        source={{ uri: iconUrl }}
        className="w-10 h-10 rounded-xl"
        resizeMode="cover"
      />
    )
  }
  return (
    <View
      className="w-10 h-10 rounded-xl items-center justify-center"
      style={{ backgroundColor: `${accent}33` }}
    >
      <Text style={{ color: accent, fontSize: 16, fontWeight: '700' }}>
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

  const loadInstalls = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await http.get<{ installs: InstallRow[] }>('/api/marketplace/my-installs')
      const items = res.data?.installs ?? []
      setInstalls(items)
      // Kick off update checks in parallel — they're independent so
      // we don't need to chain them, and the per-row loading flag
      // shows a spinner inside the card while we wait.
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
    // refreshOne dependency intentionally omitted — declared below
    // and stable across renders via the http closure.
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
              appliedNotice: 'Update applied.',
            },
          }))
          // Re-check after apply so we get a fresh drift baseline.
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
                  ? 'You have local changes — use Force update to overwrite them.'
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

  const openProject = useCallback(
    (projectId: string) => {
      router.push(`/(app)/projects/${projectId}` as any)
    },
    [router],
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
      <View className="border-b border-border">
        <View className="flex-row items-center gap-3 px-5 pt-3 pb-2">
          <Pressable onPress={() => router.back()} hitSlop={6} className="p-1">
            <ArrowLeft size={20} color="#71717a" />
          </Pressable>
          <View className="flex-1 min-w-0">
            <Text className="text-base font-semibold text-foreground">My installs</Text>
            {!loadError && sortedInstalls.length > 0 && (
              <Text className="text-[11px] text-muted-foreground mt-0.5">
                {sortedInstalls.length} installed
                {updateCount > 0 ? ` · ${updateCount} update${updateCount === 1 ? '' : 's'} available` : ''}
              </Text>
            )}
          </View>
        </View>
        {!loadError && sortedInstalls.length > 0 && (
          <View className="px-5 pb-3">
            <View className="flex-row items-center bg-card border border-input rounded-xl px-3 h-10">
              <Search size={16} color="#71717a" />
              <TextInput
                className="flex-1 ml-2 text-sm text-foreground web:outline-none no-focus-ring"
                placeholder="Search installs…"
                placeholderTextColor="#71717a"
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searchQuery.length > 0 && (
                <Pressable onPress={() => setSearchQuery('')} hitSlop={6}>
                  <X size={14} color="#71717a" />
                </Pressable>
              )}
            </View>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {loadError && (
          <View className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-6 gap-2">
            <Text className="text-sm font-semibold text-destructive">Could not load installs</Text>
            <Text className="text-xs text-foreground/80">{loadError}</Text>
            <Pressable
              onPress={onRefresh}
              className="mt-2 self-start px-3 py-2 rounded-lg bg-primary active:opacity-80"
            >
              <Text className="text-xs font-semibold text-primary-foreground">Retry</Text>
            </Pressable>
          </View>
        )}
        {!loadError && sortedInstalls.length === 0 && (
          <View className="rounded-2xl border border-border bg-card px-5 py-10 items-center gap-3">
            <Package size={28} color="#71717a" />
            <Text className="text-sm font-semibold text-foreground">No installs yet</Text>
            <Text className="text-xs text-muted-foreground text-center">
              Browse the marketplace to install your first agent.
            </Text>
            <Pressable
              onPress={() => router.push('/(app)/marketplace' as any)}
              className="mt-1 px-4 py-2.5 rounded-xl bg-primary active:opacity-80"
            >
              <Text className="text-xs font-semibold text-primary-foreground">
                Browse marketplace
              </Text>
            </Pressable>
          </View>
        )}
        {!loadError && sortedInstalls.length > 0 && filteredInstalls.length === 0 && (
          <View className="rounded-2xl border border-border bg-card px-5 py-10 items-center gap-2">
            <Search size={28} color="#71717a" />
            <Text className="text-sm font-semibold text-foreground">No matching installs</Text>
            <Text className="text-xs text-muted-foreground text-center">
              Try a different search term.
            </Text>
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
              className="rounded-2xl border border-border bg-card overflow-hidden"
            >
              <Pressable
                onPress={() => openProject(inst.projectId)}
                className="p-4 gap-3 active:opacity-95"
              >
              <View className="flex-row items-center gap-3">
                <InstallListingIcon
                  iconUrl={inst.listing.iconUrl}
                  title={inst.listing.title}
                />
                <View className="flex-1 min-w-0">
                  <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
                    {inst.listing.title}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground">
                    v{state.installedVersion}
                    {state.hasUpdate ? ` → v${state.currentVersion}` : ''}
                    {' · '}
                    {INSTALL_MODEL_LABELS[inst.installModel]}
                  </Text>
                </View>
                {state.hasUpdate && (
                  <View className="px-2 py-1 rounded-full bg-amber-500/15">
                    <Text className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                      Update available
                    </Text>
                  </View>
                )}
                {!state.hasUpdate && !state.loading && driftCount === 0 && (
                  <CheckCircle2 size={14} color="#16a34a" />
                )}
              </View>

              {state.changelog && (
                <View className="rounded-xl bg-muted/30 px-3 py-2">
                  <Text className="text-[10px] uppercase font-semibold text-muted-foreground mb-1">
                    Changelog
                  </Text>
                  <Text className="text-xs text-foreground/80">{state.changelog}</Text>
                </View>
              )}

              {driftCount > 0 && (
                <View className="rounded-xl border border-amber-300/40 bg-amber-50/40 dark:bg-amber-900/10 px-3 py-2 flex-row gap-2">
                  <AlertTriangle size={12} color="#d97706" style={{ marginTop: 2 }} />
                  <View className="flex-1">
                    <Text className="text-[11px] font-semibold text-foreground">
                      You've modified this install
                    </Text>
                    <Text className="text-[11px] text-foreground/80 mt-0.5">
                      {drift!.modified.length} modified · {drift!.added.length} added ·{' '}
                      {drift!.deleted.length} deleted
                    </Text>
                  </View>
                </View>
              )}

              {state.error && (
                <Text className="text-[11px] text-destructive">{state.error}</Text>
              )}
              {state.appliedNotice && (
                <Text className="text-[11px] text-emerald-600">{state.appliedNotice}</Text>
              )}
              </Pressable>

              {state.hasUpdate && (
                <View className="flex-row gap-2 px-4 pb-4">
                  <Pressable
                    onPress={() => handleApply(inst.id, false)}
                    disabled={state.applying}
                    className={cn(
                      'flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-xl',
                      state.applying ? 'bg-primary/40' : 'bg-primary active:opacity-80',
                    )}
                  >
                    {state.applying ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <RefreshCw size={12} color="#fff" />
                    )}
                    <Text className="text-xs font-semibold text-primary-foreground">
                      Apply update
                    </Text>
                  </Pressable>
                  {driftCount > 0 && (
                    <Pressable
                      onPress={() => handleApply(inst.id, true)}
                      disabled={state.applying}
                      className={cn(
                        'flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-xl',
                        state.applying ? 'bg-destructive/40' : 'bg-destructive/15 active:opacity-80',
                      )}
                    >
                      <AlertTriangle size={12} color="#dc2626" />
                      <Text className="text-xs font-semibold text-destructive">
                        Force update (overwrite)
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
})
