// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Access Tab — who may use what (SHO-417).
 *
 * Three sections, in the order an admin needs them:
 *
 *   Your access      what the signed-in person may do, and a way to ask for
 *                    more. Any member sees this; the request is theirs alone.
 *   Requests         the open queue, with approve/deny. Admin only.
 *   Policies         the rows that decide the above, editable per role or per
 *                    member. Admin only.
 *
 * The server is the gate: every route here re-checks `workspace.settings:manage`
 * for the admin surfaces and resolves the requester from the session, so this
 * screen is a convenience, not the enforcement point.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native'
import { observer } from 'mobx-react-lite'
import { Check as CheckIcon, Lock as LockIcon, ShieldCheck as ShieldCheckIcon } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { api, createHttpClient } from '../../lib/api'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { usePermissions } from '../../hooks/usePermissions'
import { Text, useAccountSheetIcons } from './account-sheet-chrome'

interface AbilityOption {
  id: string
  label: string
  group: string
}

interface ModelOption {
  id: string
  displayName: string
  tier: string
}

interface PolicyRow {
  subjectType: 'role' | 'group' | 'member'
  subjectId: string
  abilities: string[] | null
  modelTiers: string[] | null
  modelIds: string[] | null
  defaultModelId: string | null
  spendCapUsd: number | null
  spendPeriod: string | null
  requestsPerHour: number | null
}

interface EffectiveAccess {
  role: string
  abilities: string[]
  models: string[]
  defaultModelId: string | null
  spendCapUsd: number | null
  spendPeriod: string | null
  requestsPerHour: number | null
  reasons: string[]
}

interface AccessRequest {
  id: string
  userId: string
  permission: string | null
  modelId: string | null
  reason: string | null
  createdAt: string
  status: 'open' | 'granted' | 'denied'
}

interface MemberOption {
  id: string
  name: string
}

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const
const SPEND_PERIODS = ['day', 'week', 'month'] as const

function errorMessage(err: unknown, fallback: string): string {
  const message = (err as { message?: unknown })?.message
  return typeof message === 'string' && message ? message : fallback
}

export const WorkspaceAccessTab = observer(function WorkspaceAccessTab() {
  const { ShieldCheck, Check, Lock } = useAccountSheetIcons({
    ShieldCheck: ShieldCheckIcon,
    Check: CheckIcon,
    Lock: LockIcon,
  })
  const http = useMemo(() => createHttpClient(), [])
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? null
  const { can } = usePermissions({ workspaceId })
  const canManage = can('workspace.settings:manage')

  const [effective, setEffective] = useState<EffectiveAccess | null>(null)
  const [abilities, setAbilities] = useState<AbilityOption[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelTiers, setModelTiers] = useState<string[]>([])
  const [policies, setPolicies] = useState<PolicyRow[]>([])
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const own = await http.get<EffectiveAccess>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/access/effective`,
      )
      setEffective(own.data ?? null)

      if (canManage) {
        const [catalog, queue, people] = await Promise.all([
          http.get<{ policies: PolicyRow[]; abilities: AbilityOption[]; modelTiers: string[]; models: ModelOption[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/access/policies`,
          ),
          http.get<{ requests: AccessRequest[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/access/requests?status=open`,
          ),
          api.getWorkspaceMembers(http, workspaceId).catch(() => []),
        ])
        setPolicies(catalog.data?.policies ?? [])
        setAbilities(catalog.data?.abilities ?? [])
        setModelTiers(catalog.data?.modelTiers ?? [])
        setModels(catalog.data?.models ?? [])
        setRequests(queue.data?.requests ?? [])
        setMembers(
          (people as Array<{ user?: { id: string; name?: string; email?: string } }>)
            .map((m) => m.user)
            .filter((u): u is { id: string; name?: string; email?: string } => !!u?.id)
            .map((u) => ({ id: u.id, name: u.name || u.email || u.id })),
        )
      }
    } catch (err) {
      setError(errorMessage(err, 'Failed to load access settings'))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, canManage, http])

  useEffect(() => {
    load()
  }, [load])

  const decide = useCallback(
    async (requestId: string, approve: boolean) => {
      if (!workspaceId) return
      setBusy(true)
      setError(null)
      try {
        await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/access/requests/${requestId}/decide`, {
          approve,
        })
        setNotice(approve ? 'Access granted' : 'Request denied')
        await load()
      } catch (err) {
        setError(errorMessage(err, 'Failed to decide the request'))
      } finally {
        setBusy(false)
      }
    },
    [workspaceId, http, load],
  )

  const request = useCallback(
    async (item: { permission?: string; modelId?: string }, reason?: string) => {
      if (!workspaceId) return
      setBusy(true)
      setError(null)
      try {
        await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/access/requests`, { ...item, reason })
        setNotice('Request sent to your workspace admins')
      } catch (err) {
        setError(errorMessage(err, 'Failed to send the request'))
      } finally {
        setBusy(false)
      }
    },
    [workspaceId, http],
  )

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
    <View className="gap-6">
      <YourAccessCard
        effective={effective}
        abilities={abilities}
        models={models}
        canManage={canManage}
        busy={busy}
        onRequest={request}
        icon={<ShieldCheck size={16} className="text-foreground" />}
        lockIcon={<Lock size={12} className="text-muted-foreground" />}
      />

      {canManage && (
        <RequestsCard
          requests={requests}
          members={members}
          busy={busy}
          onDecide={decide}
          icon={<ShieldCheck size={16} className="text-foreground" />}
        />
      )}

      {canManage && (
        <PoliciesCard
          workspaceId={workspaceId}
          http={http}
          policies={policies}
          abilities={abilities}
          models={models}
          modelTiers={modelTiers}
          members={members}
          onChanged={load}
          onError={setError}
          onNotice={setNotice}
          icon={<ShieldCheck size={16} className="text-foreground" />}
          checkIcon={<Check size={13} color="#fff" />}
        />
      )}

      {error && <Text className="text-xs text-red-500">{error}</Text>}
      {notice && <Text className="text-xs text-green-600">{notice}</Text>}
    </View>
  )
})

function SectionHeader({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <View className="px-5 py-4 border-b border-border">
      <View className="flex-row items-center gap-2.5">
        {icon}
        <Text className="text-base font-semibold text-foreground">{title}</Text>
      </View>
      <Text className="text-xs text-muted-foreground mt-1">{description}</Text>
      {children}
    </View>
  )
}

function YourAccessCard({
  effective,
  abilities,
  models,
  canManage,
  busy,
  onRequest,
  icon,
  lockIcon,
}: {
  effective: EffectiveAccess | null
  abilities: AbilityOption[]
  models: ModelOption[]
  canManage: boolean
  busy: boolean
  onRequest: (item: { permission?: string; modelId?: string }, reason?: string) => Promise<void>
  icon: React.ReactNode
  lockIcon: React.ReactNode
}) {
  const [reason, setReason] = useState('')
  const held = useMemo(() => new Set(effective?.abilities ?? []), [effective])
  const usable = useMemo(() => new Set(effective?.models ?? []), [effective])

  // Only offer what the person does not already have, and only abilities the
  // workspace can actually grant (the catalog comes from the server).
  const missingAbilities = useMemo(
    () => abilities.filter((a) => !held.has(a.id)),
    [abilities, held],
  )
  const missingModels = useMemo(() => models.filter((m) => !usable.has(m.id)), [models, usable])

  return (
    <View className="bg-card border border-border rounded-xl">
      <SectionHeader
        icon={icon}
        title="Your access"
        description={
          effective
            ? `You are a workspace ${effective.role}. ${effective.abilities.length} abilities, ${effective.models.length} models.`
            : 'Your access could not be read.'
        }
      >
        {effective && effective.reasons.length > 0 && (
          <Text className="text-[11px] text-muted-foreground mt-1">
            From {effective.reasons.join(', ')}
          </Text>
        )}
        {effective && (effective.spendCapUsd != null || effective.requestsPerHour != null) && (
          <Text className="text-[11px] text-muted-foreground mt-1">
            {effective.spendCapUsd != null
              ? `Spend cap $${effective.spendCapUsd} per ${effective.spendPeriod ?? 'month'}`
              : ''}
            {effective.spendCapUsd != null && effective.requestsPerHour != null ? ' · ' : ''}
            {effective.requestsPerHour != null ? `${effective.requestsPerHour} requests/hour` : ''}
          </Text>
        )}
      </SectionHeader>

      <View className="px-5 py-4 gap-3">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Abilities
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          {(effective?.abilities ?? []).map((id) => (
            <View key={id} className="px-2 py-1 rounded-md bg-muted">
              <Text className="text-[11px] text-foreground">{id}</Text>
            </View>
          ))}
          {(effective?.abilities ?? []).length === 0 && (
            <Text className="text-xs text-muted-foreground">No abilities.</Text>
          )}
        </View>
      </View>

      {!canManage && (missingAbilities.length > 0 || missingModels.length > 0) && (
        <View className="px-5 py-4 border-t border-border gap-3">
          <View className="flex-row items-center gap-1.5">
            {lockIcon}
            <Text className="text-[11px] text-muted-foreground">
              Need more? Ask a workspace admin — they decide, not you.
            </Text>
          </View>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Why you need it (optional)"
            placeholderTextColor="#8b8b8b"
            className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {missingAbilities.map((a) => (
              <Pressable
                key={a.id}
                disabled={busy}
                onPress={() => onRequest({ permission: a.id }, reason)}
                className={cn('px-3 py-2 rounded-lg border border-border bg-background', busy && 'opacity-60')}
              >
                <Text className="text-xs text-foreground">Request {a.label}</Text>
              </Pressable>
            ))}
            {missingModels.map((m) => (
              <Pressable
                key={m.id}
                disabled={busy}
                onPress={() => onRequest({ modelId: m.id }, reason)}
                className={cn('px-3 py-2 rounded-lg border border-border bg-background', busy && 'opacity-60')}
              >
                <Text className="text-xs text-foreground">Request {m.displayName}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  )
}

function RequestsCard({
  requests,
  members,
  busy,
  onDecide,
  icon,
}: {
  requests: AccessRequest[]
  members: MemberOption[]
  busy: boolean
  onDecide: (requestId: string, approve: boolean) => Promise<void>
  icon: React.ReactNode
}) {
  const nameOf = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members])

  return (
    <View className="bg-card border border-border rounded-xl">
      <SectionHeader
        icon={icon}
        title="Requests"
        description={
          requests.length === 0
            ? 'Nobody is waiting on you.'
            : `${requests.length} open ${requests.length === 1 ? 'request' : 'requests'}.`
        }
      />
      {requests.length > 0 && (
        <View className="px-5 py-4 gap-3">
          {requests.map((r) => (
            <View key={r.id} className="rounded-lg border border-border bg-background px-3 py-3 gap-2">
              <Text className="text-sm text-foreground">
                {nameOf.get(r.userId) ?? r.userId} asked for {r.permission ?? r.modelId}
              </Text>
              {r.reason && <Text className="text-[11px] text-muted-foreground">{r.reason}</Text>}
              <View className="flex-row items-center gap-2">
                <Pressable
                  disabled={busy}
                  onPress={() => onDecide(r.id, true)}
                  className={cn('px-3 py-2 rounded-md bg-primary', busy && 'opacity-60')}
                >
                  <Text className="text-xs font-medium text-primary-foreground">Approve</Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => onDecide(r.id, false)}
                  className={cn('px-3 py-2 rounded-md border border-border', busy && 'opacity-60')}
                >
                  <Text className="text-xs font-medium text-foreground">Deny</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function PoliciesCard({
  workspaceId,
  http,
  policies,
  abilities,
  models,
  modelTiers,
  members,
  onChanged,
  onError,
  onNotice,
  icon,
  checkIcon,
}: {
  workspaceId: string
  http: ReturnType<typeof createHttpClient>
  policies: PolicyRow[]
  abilities: AbilityOption[]
  models: ModelOption[]
  modelTiers: string[]
  members: MemberOption[]
  onChanged: () => Promise<void>
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
  icon: React.ReactNode
  checkIcon: React.ReactNode
}) {
  const [subjectType, setSubjectType] = useState<'role' | 'member'>('role')
  const [subjectId, setSubjectId] = useState<string>('member')
  const [draft, setDraft] = useState<PolicyRow | null>(null)
  const [saving, setSaving] = useState(false)

  const existing = useMemo(
    () => policies.find((p) => p.subjectType === subjectType && p.subjectId === subjectId) ?? null,
    [policies, subjectType, subjectId],
  )

  // The editor always starts from the stored row, so an admin edits what is
  // there rather than a blank slate that would silently drop a grant.
  useEffect(() => {
    setDraft(
      existing ?? {
        subjectType,
        subjectId,
        abilities: null,
        modelTiers: null,
        modelIds: null,
        defaultModelId: null,
        spendCapUsd: null,
        spendPeriod: null,
        requestsPerHour: null,
      },
    )
  }, [existing, subjectType, subjectId])

  const groups = useMemo(() => {
    const byGroup = new Map<string, AbilityOption[]>()
    for (const a of abilities) {
      const bucket = byGroup.get(a.group) ?? []
      bucket.push(a)
      byGroup.set(a.group, bucket)
    }
    return [...byGroup.entries()]
  }, [abilities])

  const toggleAbility = (id: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = new Set(prev.abilities ?? [])
      if (current.has(id)) current.delete(id)
      else current.add(id)
      return { ...prev, abilities: [...current] }
    })
  }

  const toggleTier = (tier: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      const current = new Set(prev.modelTiers ?? [])
      if (current.has(tier)) current.delete(tier)
      else current.add(tier)
      return { ...prev, modelTiers: [...current] }
    })
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    onError(null)
    onNotice(null)
    try {
      await http.put(`/api/workspaces/${encodeURIComponent(workspaceId)}/access/policies`, {
        subjectType: draft.subjectType,
        subjectId: draft.subjectId,
        abilities: draft.abilities,
        modelTiers: draft.modelTiers,
        modelIds: draft.modelIds,
        defaultModelId: draft.defaultModelId,
        spendCapUsd: draft.spendCapUsd,
        spendPeriod: draft.spendPeriod,
        requestsPerHour: draft.requestsPerHour,
      })
      onNotice('Policy saved')
      await onChanged()
    } catch (err) {
      onError(errorMessage(err, 'Failed to save the policy'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: PolicyRow) => {
    setSaving(true)
    onError(null)
    onNotice(null)
    try {
      await http.delete(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/access/policies/${row.subjectType}/${encodeURIComponent(row.subjectId)}`,
      )
      onNotice('Policy removed — that subject is back to its role default')
      await onChanged()
    } catch (err) {
      onError(errorMessage(err, 'Failed to remove the policy'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <View className="bg-card border border-border rounded-xl">
      <SectionHeader
        icon={icon}
        title="Policies"
        description="A role policy replaces that role's default abilities. A member policy only adds. Nothing can widen the workspace's model allowlist."
      />

      <View className="px-5 py-4 gap-4">
        <View className="flex-row gap-2">
          {(['role', 'member'] as const).map((type) => (
            <Pressable
              key={type}
              onPress={() => {
                setSubjectType(type)
                setSubjectId(type === 'role' ? 'member' : members[0]?.id ?? '')
              }}
              className={cn(
                'px-3 py-2 rounded-lg border',
                subjectType === type ? 'border-primary bg-primary/5' : 'border-border bg-background',
              )}
            >
              <Text className="text-xs text-foreground">{type === 'role' ? 'Role' : 'Member'}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {(subjectType === 'role' ? ROLES.map((r) => ({ id: r, name: r })) : members).map((option) => (
            <Pressable
              key={option.id}
              onPress={() => setSubjectId(option.id)}
              className={cn(
                'px-3 py-2 rounded-lg border',
                subjectId === option.id ? 'border-primary bg-primary/5' : 'border-border bg-background',
              )}
            >
              <Text className="text-xs text-foreground">{option.name}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {draft && (
          <>
            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Abilities
            </Text>
            {groups.map(([group, items]) => (
              <View key={group} className="gap-1.5">
                <Text className="text-[11px] text-muted-foreground">{group}</Text>
                {items.map((a) => {
                  const checked = (draft.abilities ?? []).includes(a.id)
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => toggleAbility(a.id)}
                      className={cn(
                        'px-3 py-2.5 rounded-lg border flex-row items-center gap-3',
                        checked ? 'border-primary/50 bg-primary/5' : 'border-border bg-background',
                      )}
                    >
                      <View
                        className={cn(
                          'w-5 h-5 rounded-md border items-center justify-center',
                          checked ? 'border-primary bg-primary' : 'border-border bg-background',
                        )}
                      >
                        {checked && checkIcon}
                      </View>
                      <Text className="text-sm text-foreground flex-1">{a.label}</Text>
                    </Pressable>
                  )
                })}
              </View>
            ))}

            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mt-2">
              Model tiers
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {modelTiers.map((tier) => {
                const checked = (draft.modelTiers ?? []).includes(tier)
                return (
                  <Pressable
                    key={tier}
                    onPress={() => toggleTier(tier)}
                    className={cn(
                      'px-3 py-2 rounded-lg border',
                      checked ? 'border-primary bg-primary/5' : 'border-border bg-background',
                    )}
                  >
                    <Text className="text-xs text-foreground">{tier}</Text>
                  </Pressable>
                )
              })}
            </View>

            <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mt-2">
              Limits
            </Text>
            <View className="flex-row gap-2">
              <TextInput
                value={draft.spendCapUsd == null ? '' : String(draft.spendCapUsd)}
                onChangeText={(text) =>
                  setDraft((prev) =>
                    prev ? { ...prev, spendCapUsd: text.trim() === '' ? null : Number(text) } : prev,
                  )
                }
                keyboardType="decimal-pad"
                placeholder="Spend cap (USD)"
                placeholderTextColor="#8b8b8b"
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
              />
              <TextInput
                value={draft.requestsPerHour == null ? '' : String(draft.requestsPerHour)}
                onChangeText={(text) =>
                  setDraft((prev) =>
                    prev ? { ...prev, requestsPerHour: text.trim() === '' ? null : Number(text) } : prev,
                  )
                }
                keyboardType="number-pad"
                placeholder="Requests/hour"
                placeholderTextColor="#8b8b8b"
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
              />
            </View>
            <View className="flex-row gap-2">
              {SPEND_PERIODS.map((period) => (
                <Pressable
                  key={period}
                  onPress={() => setDraft((prev) => (prev ? { ...prev, spendPeriod: period } : prev))}
                  className={cn(
                    'px-3 py-2 rounded-lg border',
                    draft.spendPeriod === period ? 'border-primary bg-primary/5' : 'border-border bg-background',
                  )}
                >
                  <Text className="text-xs text-foreground">per {period}</Text>
                </Pressable>
              ))}
            </View>

            <View className="flex-row items-center gap-2 mt-1">
              <Pressable
                onPress={save}
                disabled={saving}
                className={cn('px-4 py-2.5 rounded-md', saving ? 'bg-muted' : 'bg-primary')}
              >
                {saving ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text className="text-sm font-medium text-primary-foreground">Save policy</Text>
                )}
              </Pressable>
              {existing && (
                <Pressable
                  onPress={() => remove(existing)}
                  disabled={saving}
                  className={cn('px-4 py-2.5 rounded-md border border-border', saving && 'opacity-60')}
                >
                  <Text className="text-sm text-foreground">Remove</Text>
                </Pressable>
              )}
            </View>
          </>
        )}
      </View>

      {policies.length > 0 && (
        <View className="px-5 py-4 border-t border-border gap-2">
          <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            All policies
          </Text>
          {policies.map((p) => (
            <View
              key={`${p.subjectType}:${p.subjectId}`}
              className="rounded-lg border border-border bg-background px-3 py-2.5 flex-row items-center gap-3"
            >
              <View className="flex-1">
                <Text className="text-sm text-foreground">
                  {p.subjectType} · {p.subjectId}
                </Text>
                <Text className="text-[11px] text-muted-foreground mt-0.5">
                  {p.abilities?.length ?? 0} abilities
                  {p.modelTiers?.length ? ` · tiers ${p.modelTiers.join(', ')}` : ''}
                  {p.modelIds?.length ? ` · ${p.modelIds.length} models` : ''}
                  {p.spendCapUsd != null ? ` · $${p.spendCapUsd}/${p.spendPeriod ?? 'month'}` : ''}
                </Text>
              </View>
              <Pressable onPress={() => remove(p)} disabled={saving} className={cn(saving && 'opacity-60')}>
                <Text className="text-xs text-red-500">Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
