// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Models Tab — workspace owner/admin curated model visibility.
 *
 * Lets a workspace admin pick which models their team can see and use, as a
 * SUBSET of the platform-visible set (which the super-admin controls). The
 * candidate list is the full platform-visible set (`getVisibleModels`); the
 * current selection comes from the workspace's allowlist
 * (`getWorkspaceVisibleModels` -> `allowedModelIds`, where `null` = inherit
 * all). Saving writes the allowlist back and refreshes the chat picker.
 *
 * Editing is gated to owner/admin; other members see a read-only view. The
 * server enforces both the admin check and the subset rule, and the AI proxy
 * hard-blocks hidden models, so this UI is a convenience, not the gate.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { observer } from 'mobx-react-lite'
import { Boxes, Check, Lock } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi } from '@shogo-ai/sdk'
import { createHttpClient } from '../../lib/api'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useMemberCollection } from '../../contexts/domain'
import { useAuth } from '../../contexts/auth'
import { invalidateVisibleModelsCache } from '../../lib/visible-models'

interface Candidate {
  id: string
  displayName: string
  provider: string
  tier?: string
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'Anthropic'
    case 'openai': return 'OpenAI'
    case 'google': return 'Google'
    case 'openrouter': return 'OpenRouter'
    case 'custom': return 'Custom'
    case 'local': return 'Local'
    default: return provider.charAt(0).toUpperCase() + provider.slice(1)
  }
}

export const WorkspaceModelsTab = observer(function WorkspaceModelsTab() {
  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? null
  const members = useMemberCollection()
  const { user } = useAuth()

  const [candidates, setCandidates] = useState<Candidate[]>([])
  // null = inherit (allow all platform-visible models); a Set is the explicit
  // allowlist the admin has curated.
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)

  const canManage = useMemo(() => {
    if (!workspaceId) return false
    const all = Array.isArray(members.all) ? members.all : []
    const mine = all.find(
      (m: any) => m.userId === user?.id && m.workspaceId === workspaceId && !m.projectId,
    )
    return mine?.role === 'owner' || mine?.role === 'admin'
  }, [members.all, workspaceId, user?.id])

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      try { await members.loadAll({ workspaceId }) } catch { /* role falls back to read-only */ }
      const [platformSet, ws] = await Promise.all([
        platform.getVisibleModels(),
        platform.getWorkspaceVisibleModels(workspaceId),
      ])
      const cand: Candidate[] = [
        ...(platformSet.catalogModels ?? []).map((m) => ({
          id: m.id,
          displayName: m.displayName,
          provider: m.provider,
          tier: m.tier,
        })),
        ...(platformSet.openrouterModels ?? []).map((m) => ({
          id: m.id,
          displayName: m.displayName,
          provider: 'openrouter',
          tier: m.tier,
        })),
      ]
      setCandidates(cand)
      setSelected(ws.allowedModelIds == null ? null : new Set(ws.allowedModelIds))
    } catch (err: any) {
      setError(err?.message || 'Failed to load models')
    } finally {
      setLoading(false)
    }
  }, [workspaceId, platform, members])

  useEffect(() => { load() }, [load])

  const allowAll = selected === null
  const isChecked = useCallback(
    (id: string) => allowAll || selected!.has(id),
    [allowAll, selected],
  )

  const setAllowAll = useCallback((next: boolean) => {
    if (!canManage) return
    // Switching off "allow all" seeds the selection with every candidate, so
    // the admin removes models from a full list rather than starting empty.
    setSelected(next ? null : new Set(candidates.map((c) => c.id)))
  }, [canManage, candidates])

  const toggleModel = useCallback((id: string) => {
    if (!canManage) return
    setSelected((prev) => {
      const base = prev === null ? new Set(candidates.map((c) => c.id)) : new Set(prev)
      if (base.has(id)) base.delete(id)
      else base.add(id)
      return base
    })
  }, [canManage, candidates])

  const save = useCallback(async () => {
    if (!workspaceId || !canManage) return
    setSaving(true)
    setError(null)
    try {
      const ids = allowAll ? null : Array.from(selected!)
      await platform.putWorkspaceVisibleModels(workspaceId, ids)
      invalidateVisibleModelsCache(workspaceId)
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [workspaceId, canManage, allowAll, selected, platform])

  const groups = useMemo(() => {
    const byLabel = new Map<string, Candidate[]>()
    const order: string[] = []
    for (const c of candidates) {
      const label = providerLabel(c.provider)
      let bucket = byLabel.get(label)
      if (!bucket) {
        bucket = []
        byLabel.set(label, bucket)
        order.push(label)
      }
      bucket.push(c)
    }
    return order.map((label) => ({ label, models: byLabel.get(label)! }))
  }, [candidates])

  const selectedCount = allowAll ? candidates.length : selected!.size

  if (!workspaceId) {
    return (
      <View className="bg-card border border-border rounded-xl px-5 py-6">
        <Text className="text-sm text-muted-foreground">No workspace selected.</Text>
      </View>
    )
  }

  if (loading) {
    return (
      <View className="bg-card border border-border rounded-xl px-5 py-6 items-center">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  return (
    <View className="bg-card border border-border rounded-xl">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center gap-2.5">
          <Boxes size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">Models</Text>
        </View>
        <Text className="text-xs text-muted-foreground mt-1">
          Choose which models your team can see and use. You can only enable models your
          plan administrator has made available. {selectedCount} of {candidates.length} enabled
          {allowAll ? ' (all)' : ''}.
        </Text>
        {!canManage && (
          <View className="flex-row items-center gap-1.5 mt-2">
            <Lock size={12} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              Only workspace owners and admins can change this.
            </Text>
          </View>
        )}
      </View>

      {/* Allow all toggle */}
      <Pressable
        onPress={() => setAllowAll(!allowAll)}
        disabled={!canManage}
        className={cn(
          'px-5 py-4 border-b border-border flex-row items-center justify-between',
          !canManage && 'opacity-60',
        )}
      >
        <View className="flex-1 mr-3">
          <Text className="text-sm font-medium text-foreground">Allow all available models</Text>
          <Text className="text-[11px] text-muted-foreground mt-0.5">
            New models added by your administrator are shown automatically.
          </Text>
        </View>
        <View
          className={cn(
            'w-5 h-5 rounded-md border items-center justify-center',
            allowAll ? 'border-primary bg-primary' : 'border-border bg-background',
          )}
        >
          {allowAll && <Check size={13} color="#fff" />}
        </View>
      </Pressable>

      <View className="px-5 py-4 gap-4">
        {error && <Text className="text-xs text-red-500">{error}</Text>}

        {candidates.length === 0 && (
          <Text className="text-xs text-muted-foreground">
            No models are available on this platform yet.
          </Text>
        )}

        {groups.map((group) => (
          <View key={group.label} className="gap-1.5">
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </Text>
            {group.models.map((m) => {
              const checked = isChecked(m.id)
              return (
                <Pressable
                  key={m.id}
                  onPress={() => toggleModel(m.id)}
                  disabled={!canManage || allowAll}
                  className={cn(
                    'px-3 py-2.5 rounded-lg border flex-row items-center gap-3',
                    checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-background',
                    (!canManage || allowAll) && 'opacity-60',
                  )}
                >
                  <View
                    className={cn(
                      'w-5 h-5 rounded-md border items-center justify-center',
                      checked ? 'border-primary bg-primary' : 'border-border bg-background',
                    )}
                  >
                    {checked && <Check size={13} color="#fff" />}
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm text-foreground">{m.displayName}</Text>
                    <Text className="text-[11px] text-muted-foreground mt-0.5" numberOfLines={1}>
                      {m.id}{m.tier ? ` · ${m.tier}` : ''}
                    </Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        ))}
      </View>

      {canManage && (
        <View className="px-5 py-3 border-t border-border flex-row items-center justify-end gap-3">
          {savedAt > 0 && !saving && (
            <Text className="text-[11px] text-green-600">Saved</Text>
          )}
          <Pressable
            onPress={save}
            disabled={saving}
            className={cn('items-center px-4 py-2.5 rounded-md', saving ? 'bg-muted' : 'bg-primary')}
          >
            {saving ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="text-sm font-medium text-primary-foreground">Save changes</Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  )
})
