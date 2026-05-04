// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Credit Grant Detail / Edit
 *
 * One screen handles both creating a new grant (id === 'new') and
 * editing/expiring/applying an existing one. The "Apply now" button
 * pushes the grant into the workspace's wallet immediately via
 * `POST /api/admin/workspace-grants/:id/apply` instead of waiting for
 * the next monthly cycle.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ArrowLeft,
  Gift,
  Save,
  Trash2,
  Zap,
  Calendar,
  Building2,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

const API_BASE = `${API_URL}/api/admin`

interface AdminGrant {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  startsAt: string
  expiresAt: string | null
  note: string | null
  createdByUserId: string | null
  createdAt: string
  updatedAt: string
}

interface WorkspaceLite {
  id: string
  name: string
  slug: string
}

async function fetchAdminJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

async function postAdmin<T>(
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` }
    }
    return { ok: true, data: json?.data }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'request failed' }
  }
}

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function fromDateInput(s: string): string | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  // Treat the input as local midnight; consumers only care about the day.
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export default function AdminGrantDetailPage() {
  const params = useLocalSearchParams<{ id: string; workspaceId?: string }>()
  const id = params.id
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const isNew = !id || id === 'new'

  const [grant, setGrant] = useState<AdminGrant | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceLite | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [busyAction, setBusyAction] = useState<null | 'apply' | 'delete' | 'expire'>(null)

  const [workspaceId, setWorkspaceId] = useState(params.workspaceId ?? '')
  const [freeSeats, setFreeSeats] = useState('0')
  const [monthlyIncludedUsd, setMonthlyIncludedUsd] = useState('0')
  const [startsAt, setStartsAt] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [note, setNote] = useState('')

  const loadGrant = useCallback(async () => {
    if (isNew) return
    const data = await fetchAdminJson<AdminGrant>(`/workspace-grants/${id}`)
    setGrant(data)
    if (data) {
      setWorkspaceId(data.workspaceId)
      setFreeSeats(String(data.freeSeats))
      setMonthlyIncludedUsd(String(data.monthlyIncludedUsd))
      setStartsAt(toDateInput(data.startsAt))
      setExpiresAt(toDateInput(data.expiresAt))
      setNote(data.note ?? '')
      const w = await fetchAdminJson<WorkspaceLite>(`/workspaces/${data.workspaceId}`)
      setWorkspace(w)
    }
    setLoading(false)
  }, [id, isNew])

  useEffect(() => {
    loadGrant()
  }, [loadGrant])

  // For new grants, hydrate the workspace summary as soon as the
  // admin pastes / picks a valid id.
  useEffect(() => {
    if (!isNew) return
    if (!workspaceId || workspaceId.length < 8) {
      setWorkspace(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const w = await fetchAdminJson<WorkspaceLite>(`/workspaces/${workspaceId}`)
      if (!cancelled) setWorkspace(w)
    })()
    return () => {
      cancelled = true
    }
  }, [isNew, workspaceId])

  const onSave = async () => {
    const payload = {
      workspaceId: workspaceId.trim(),
      freeSeats: Math.max(0, parseInt(freeSeats || '0', 10) || 0),
      monthlyIncludedUsd: Math.max(0, parseFloat(monthlyIncludedUsd || '0') || 0),
      startsAt: fromDateInput(startsAt) ?? new Date().toISOString(),
      expiresAt: fromDateInput(expiresAt),
      note: note.trim() || null,
    }
    if (!payload.workspaceId) {
      Alert.alert('Validation', 'Workspace ID is required.')
      return
    }
    setSaving(true)
    const result = isNew
      ? await postAdmin<AdminGrant>('/workspace-grants', payload, 'POST')
      : await postAdmin<AdminGrant>(`/workspace-grants/${id}`, payload, 'PATCH')
    setSaving(false)
    if (!result.ok) {
      Alert.alert('Failed to save', result.error ?? 'Unknown error')
      return
    }
    if (isNew && result.data?.id) {
      // Offer to immediately apply on creation.
      const newId = result.data.id
      Alert.alert(
        'Grant created',
        'Apply it to the workspace wallet now?',
        [
          { text: 'Later', style: 'cancel', onPress: () => router.replace(`/(admin)/grants/${newId}` as any) },
          {
            text: 'Apply now',
            onPress: async () => {
              await postAdmin(`/workspace-grants/${newId}/apply`, {}, 'POST')
              router.replace(`/(admin)/grants/${newId}` as any)
            },
          },
        ],
      )
      return
    }
    loadGrant()
  }

  const onApply = async () => {
    if (!grant) return
    setBusyAction('apply')
    const result = await postAdmin(`/workspace-grants/${grant.id}/apply`, {}, 'POST')
    setBusyAction(null)
    if (!result.ok) {
      Alert.alert('Apply failed', result.error ?? 'Unknown error')
      return
    }
    Alert.alert('Applied', 'The grant has been pushed to the workspace wallet.')
  }

  const onExpire = async () => {
    if (!grant) return
    setBusyAction('expire')
    const result = await postAdmin<AdminGrant>(
      `/workspace-grants/${grant.id}`,
      { expiresAt: new Date().toISOString() },
      'PATCH',
    )
    setBusyAction(null)
    if (!result.ok) {
      Alert.alert('Expire failed', result.error ?? 'Unknown error')
      return
    }
    loadGrant()
  }

  const onDelete = async () => {
    if (!grant) return
    Alert.alert(
      'Delete grant?',
      'This permanently removes the grant. To stop the allotment without losing history, use Expire instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusyAction('delete')
            const result = await postAdmin(`/workspace-grants/${grant.id}`, {}, 'DELETE')
            setBusyAction(null)
            if (!result.ok) {
              Alert.alert('Delete failed', result.error ?? 'Unknown error')
              return
            }
            router.replace('/(admin)/grants' as any)
          },
        },
      ],
    )
  }

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={
        isWide
          ? { paddingHorizontal: 32, paddingTop: 24, paddingBottom: 48, alignItems: 'center' }
          : { padding: 16, paddingBottom: 40 }
      }
      showsVerticalScrollIndicator={false}
    >
      <View style={isWide ? { maxWidth: 760, width: '100%' } : undefined}>
        <Pressable
          onPress={() => router.replace('/(admin)/grants' as any)}
          className={cn(
            'flex-row items-center gap-2 mb-4 self-start',
            isWide
              ? 'py-1.5 px-3 rounded-lg border border-border active:bg-muted/50'
              : 'active:opacity-60',
          )}
        >
          <ArrowLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground font-medium">Back to grants</Text>
        </Pressable>

        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className="flex-row items-center gap-3 mb-1">
            <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
              <Gift size={18} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className="text-base font-bold text-foreground">
                {isNew ? 'New credit grant' : 'Edit credit grant'}
              </Text>
              {workspace ? (
                <Pressable
                  onPress={() => router.push(`/(admin)/workspaces/${workspace.id}` as any)}
                  className="flex-row items-center gap-1.5 mt-0.5 active:opacity-60"
                >
                  <Building2 size={11} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                    {workspace.name} · {workspace.slug}
                  </Text>
                </Pressable>
              ) : (
                <Text className="text-xs text-muted-foreground mt-0.5">
                  {isNew ? 'Paste a workspace ID below' : 'Workspace not found'}
                </Text>
              )}
            </View>
          </View>
        </View>

        <View className="rounded-xl border border-border bg-card p-5 gap-4">
          <Field
            label="Workspace ID"
            value={workspaceId}
            onChange={setWorkspaceId}
            editable={isNew}
            placeholder="uuid…"
            mono
          />

          <View className={cn(isWide ? 'flex-row gap-4' : 'gap-4')}>
            <View className="flex-1">
              <Field
                label="Free seats"
                value={freeSeats}
                onChange={setFreeSeats}
                keyboardType="number-pad"
                placeholder="0"
                hint="Subtracted from the Stripe seat quantity (min 1 paid seat)."
              />
            </View>
            <View className="flex-1">
              <Field
                label="Monthly USD"
                value={monthlyIncludedUsd}
                onChange={setMonthlyIncludedUsd}
                keyboardType="decimal-pad"
                placeholder="0"
                hint="Stacked on top of plan-included USD each cycle."
              />
            </View>
          </View>

          <View className={cn(isWide ? 'flex-row gap-4' : 'gap-4')}>
            <View className="flex-1">
              <Field
                label="Starts at (YYYY-MM-DD)"
                value={startsAt}
                onChange={setStartsAt}
                placeholder="today"
              />
            </View>
            <View className="flex-1">
              <Field
                label="Expires at (YYYY-MM-DD, optional)"
                value={expiresAt}
                onChange={setExpiresAt}
                placeholder="never"
              />
            </View>
          </View>

          <Field
            label="Note (internal)"
            value={note}
            onChange={setNote}
            placeholder="e.g. Q2 design partner program"
            multiline
          />

          <View className="flex-row gap-2 mt-2">
            <Pressable
              onPress={onSave}
              disabled={saving}
              className={cn(
                'flex-row items-center gap-2 bg-primary px-4 py-2.5 rounded-lg active:opacity-80',
                saving && 'opacity-60',
              )}
            >
              {saving ? (
                <ActivityIndicator size="small" />
              ) : (
                <Save size={14} className="text-primary-foreground" />
              )}
              <Text className="text-sm font-medium text-primary-foreground">
                {isNew ? 'Create grant' : 'Save changes'}
              </Text>
            </Pressable>

            {!isNew && grant && (
              <>
                <Pressable
                  onPress={onApply}
                  disabled={busyAction === 'apply'}
                  className={cn(
                    'flex-row items-center gap-2 bg-card border border-border px-4 py-2.5 rounded-lg active:bg-muted/50',
                    busyAction === 'apply' && 'opacity-60',
                  )}
                >
                  {busyAction === 'apply' ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Zap size={14} className="text-foreground" />
                  )}
                  <Text className="text-sm font-medium text-foreground">Apply now</Text>
                </Pressable>

                <Pressable
                  onPress={onExpire}
                  disabled={busyAction === 'expire'}
                  className={cn(
                    'flex-row items-center gap-2 bg-card border border-border px-4 py-2.5 rounded-lg active:bg-muted/50',
                    busyAction === 'expire' && 'opacity-60',
                  )}
                >
                  <Calendar size={14} className="text-foreground" />
                  <Text className="text-sm font-medium text-foreground">Expire</Text>
                </Pressable>

                <Pressable
                  onPress={onDelete}
                  disabled={busyAction === 'delete'}
                  className={cn(
                    'flex-row items-center gap-2 bg-destructive/10 border border-destructive/30 px-4 py-2.5 rounded-lg active:bg-destructive/20 ml-auto',
                    busyAction === 'delete' && 'opacity-60',
                  )}
                >
                  <Trash2 size={14} className="text-destructive" />
                  <Text className="text-sm font-medium text-destructive">Delete</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>

        {!isNew && grant && (
          <View className="rounded-xl border border-border bg-card p-4 mt-4">
            <Text className="text-xs text-muted-foreground">
              ID: <Text className="font-mono">{grant.id}</Text>
            </Text>
            <Text className="text-xs text-muted-foreground mt-1">
              Created {new Date(grant.createdAt).toLocaleString()}
            </Text>
            <Text className="text-xs text-muted-foreground">
              Updated {new Date(grant.updatedAt).toLocaleString()}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  keyboardType,
  editable = true,
  mono,
  multiline,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad'
  editable?: boolean
  mono?: boolean
  multiline?: boolean
}) {
  return (
    <View>
      <Text className="text-xs font-medium text-muted-foreground mb-1.5">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor="#9ca3af"
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        className={cn(
          'border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background',
          mono && 'font-mono',
          !editable && 'opacity-60',
          multiline && 'min-h-[64px]',
        )}
      />
      {hint && (
        <Text className="text-[11px] text-muted-foreground mt-1">{hint}</Text>
      )}
    </View>
  )
}
