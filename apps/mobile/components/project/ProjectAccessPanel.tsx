// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectAccessPanel - who can open this project, and with which role.
 *
 *  - Visibility: everyone in the workspace (by workspace role) vs. restricted
 *    to people explicitly added (workspace owners/admins always keep access).
 *  - Explicit project members with role pickers and remove.
 *  - Read-only list of people who get access through the workspace.
 *  - Add by email or by picking a workspace member; unknown emails become
 *    pending project invitations, outside users become project guests.
 *
 * Only rendered for callers with `project.members:manage`; the API enforces it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native'
import { Globe, Lock, Mail, Trash2, Users, X } from 'lucide-react-native'
import { PROJECT_ROLES, ROLE_LABELS, type ProjectRole, type WorkspaceRole } from '@shogo/authz'
import { cn } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { invalidatePermissions } from '../../hooks/usePermissions'
import {
  api,
  type ProjectAccessUser,
  type ProjectMembersData,
  type ProjectVisibility,
} from '../../lib/api'

interface ProjectAccessPanelProps {
  projectId: string
  /** Inline variant for an already-scrollable container (e.g. the mobile settings sheet). */
  embedded?: boolean
  onVisibilityChange?: (visibility: ProjectVisibility) => void
}

const roleLabel = (role: ProjectRole | WorkspaceRole) => ROLE_LABELS[role]

function displayName(user: ProjectAccessUser | null | undefined, fallback: string): string {
  return user?.name || user?.email || fallback
}

function errorMessage(err: any, fallback: string): string {
  const code = err?.details?.error?.code ?? err?.details?.code
  if (code === 'already_member') return 'That person already has an explicit role on this project.'
  if (code === 'invitation_exists') return 'An invitation is already pending for that email.'
  return err?.message || fallback
}

function RolePicker({
  value,
  onChange,
  disabled,
}: {
  value: ProjectRole
  onChange: (role: ProjectRole) => void
  disabled?: boolean
}) {
  return (
    <View className="flex-row rounded-lg border border-border p-0.5">
      {PROJECT_ROLES.map((role) => (
        <Pressable
          key={role}
          onPress={() => role !== value && onChange(role)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ selected: role === value, disabled }}
          className={cn('rounded-md px-2 py-1', role === value && 'bg-muted', disabled && 'opacity-50')}
        >
          <Text
            className={cn(
              'text-[11px]',
              role === value ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {roleLabel(role)}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

function Avatar({ label }: { label: string }) {
  return (
    <View className="h-7 w-7 rounded-full bg-muted items-center justify-center shrink-0">
      <Text className="text-[11px] font-semibold text-foreground">
        {(label || '?')[0]?.toUpperCase()}
      </Text>
    </View>
  )
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 mt-5">
      {children}
    </Text>
  )
}

export function ProjectAccessPanel({ projectId, embedded = false, onVisibilityChange }: ProjectAccessPanelProps) {
  const http = useDomainHttp()
  const [data, setData] = useState<ProjectMembersData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [addRole, setAddRole] = useState<ProjectRole>('member')
  const [adding, setAdding] = useState(false)
  const [addNotice, setAddNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.getProjectMembers(http, projectId))
      setError(null)
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to load project access'))
    } finally {
      setLoading(false)
    }
  }, [http, projectId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const run = useCallback(
    async (id: string, action: () => Promise<unknown>, fallback: string) => {
      setBusyId(id)
      setError(null)
      try {
        await action()
        invalidatePermissions({ projectId })
        await load()
      } catch (err: any) {
        setError(errorMessage(err, fallback))
      } finally {
        setBusyId(null)
      }
    },
    [load, projectId],
  )

  const explicitUserIds = useMemo(() => new Set((data?.members ?? []).map((m) => m.userId)), [data])

  const inheritedAccess = useMemo(
    () => (data?.workspaceMembers ?? []).filter((m) => m.effectiveRole && !explicitUserIds.has(m.userId)),
    [data, explicitUserIds],
  )

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || selectedUserId) return []
    return (data?.workspaceMembers ?? [])
      .filter((m) => !explicitUserIds.has(m.userId))
      .filter(
        (m) =>
          (m.user?.name ?? '').toLowerCase().includes(q) || (m.user?.email ?? '').toLowerCase().includes(q),
      )
      .slice(0, 5)
  }, [data, explicitUserIds, query, selectedUserId])

  const trimmedQuery = query.trim()
  const canSubmit = !!selectedUserId || /\S+@\S+\.\S+/.test(trimmedQuery)

  const handleAdd = async () => {
    if (!canSubmit || adding) return
    setAdding(true)
    setError(null)
    setAddNotice(null)
    try {
      const result = await api.addProjectMember(
        http,
        projectId,
        selectedUserId ? { userId: selectedUserId, role: addRole } : { email: trimmedQuery, role: addRole },
      )
      if (result.invitation) setAddNotice(`Invitation sent to ${result.invitation.email}.`)
      setQuery('')
      setSelectedUserId(null)
      invalidatePermissions({ projectId })
      await load()
    } catch (err: any) {
      setError(errorMessage(err, 'Failed to add person'))
    } finally {
      setAdding(false)
    }
  }

  const handleVisibility = (visibility: ProjectVisibility) => {
    if (visibility === data?.visibility) return
    void run(
      'visibility',
      async () => {
        await api.setProjectVisibility(http, projectId, visibility)
        onVisibilityChange?.(visibility)
      },
      'Failed to change visibility',
    )
  }

  if (loading) {
    return (
      <View className={cn('items-center', embedded ? 'py-6' : 'flex-1 justify-center')}>
        <ActivityIndicator size="small" />
      </View>
    )
  }

  const visibility = data?.visibility ?? 'workspace'
  const visibilityOptions: { id: ProjectVisibility; icon: typeof Globe; title: string; body: string }[] = [
    {
      id: 'workspace',
      icon: Globe,
      title: 'Workspace',
      body: 'Everyone in the workspace can open this project with their workspace role.',
    },
    {
      id: 'restricted',
      icon: Lock,
      title: 'Restricted',
      body: 'Only people added below can open it. Workspace owners and admins always keep access.',
    },
  ]

  const body = (
    <>
      <View className="flex-row items-center gap-1.5 mb-1">
        <Users size={15} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Access</Text>
      </View>
      <Text className="text-[11px] text-muted-foreground">
        Control who can see and work on this project.
      </Text>

      <SectionTitle>Visibility</SectionTitle>
      <View className="gap-2">
        {visibilityOptions.map(({ id, icon: Icon, title, body: copy }) => {
          const active = visibility === id
          return (
            <Pressable
              key={id}
              onPress={() => handleVisibility(id)}
              disabled={busyId === 'visibility'}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              className={cn(
                'flex-row items-start gap-2.5 rounded-lg border p-3',
                active ? 'border-primary/40 bg-primary/5' : 'border-border active:bg-muted',
              )}
            >
              <Icon size={15} className={active ? 'text-primary' : 'text-muted-foreground'} />
              <View className="flex-1 min-w-0">
                <Text className="text-sm font-medium text-foreground">{title}</Text>
                <Text className="text-[11px] text-muted-foreground mt-0.5">{copy}</Text>
              </View>
              {busyId === 'visibility' && active ? <ActivityIndicator size="small" /> : null}
            </Pressable>
          )
        })}
      </View>

      <SectionTitle>Add people</SectionTitle>
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <TextInput
            value={query}
            onChangeText={(t) => {
              setQuery(t)
              setSelectedUserId(null)
              setAddNotice(null)
            }}
            placeholder="Email or workspace member"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            onSubmitEditing={handleAdd}
            className="flex-1 min-w-0 h-9 px-3 text-sm text-foreground border border-border rounded-lg web:outline-none"
          />
          {selectedUserId ? (
            <Pressable
              onPress={() => {
                setSelectedUserId(null)
                setQuery('')
              }}
              hitSlop={6}
              accessibilityLabel="Clear selection"
              className="p-1 rounded active:bg-muted"
            >
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          ) : null}
        </View>
        {suggestions.length > 0 ? (
          <View className="rounded-lg border border-border">
            {suggestions.map((m) => (
              <Pressable
                key={m.userId}
                onPress={() => {
                  setSelectedUserId(m.userId)
                  setQuery(m.user?.email || m.user?.name || m.userId)
                }}
                className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
              >
                <Avatar label={displayName(m.user, m.userId)} />
                <View className="flex-1 min-w-0">
                  <Text className="text-sm text-foreground" numberOfLines={1}>
                    {displayName(m.user, m.userId)}
                  </Text>
                  {m.user?.email ? (
                    <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                      {m.user.email}
                    </Text>
                  ) : null}
                </View>
                <Text className="text-[11px] text-muted-foreground">{roleLabel(m.workspaceRole)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View className="flex-row items-center justify-between gap-2">
          <RolePicker value={addRole} onChange={setAddRole} disabled={adding} />
          <Pressable
            onPress={handleAdd}
            disabled={!canSubmit || adding}
            className={cn(
              'h-9 px-3 rounded-lg items-center justify-center',
              !canSubmit || adding ? 'bg-muted' : 'bg-primary',
            )}
          >
            {adding ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text
                className={cn(
                  'text-xs font-medium',
                  canSubmit ? 'text-primary-foreground' : 'text-muted-foreground',
                )}
              >
                Add
              </Text>
            )}
          </Pressable>
        </View>
        <Text className="text-[11px] text-muted-foreground">
          People outside the workspace join as guests with access to this project only.
        </Text>
        {addNotice ? (
          <Text className="text-[11px] text-emerald-600 dark:text-emerald-400">{addNotice}</Text>
        ) : null}
      </View>

      {error ? <Text className="text-[11px] text-destructive mt-2">{error}</Text> : null}

      <SectionTitle>Project members</SectionTitle>
      {(data?.members ?? []).length === 0 ? (
        <Text className="text-[11px] text-muted-foreground">No one has been added to this project directly.</Text>
      ) : (
        <View className="rounded-lg border border-border">
          {(data?.members ?? []).map((m, i) => {
            const name = displayName(m.user, m.userId)
            const busy = busyId === m.id
            return (
              <View
                key={m.id}
                className={cn('flex-row items-center gap-2 px-3 py-2', i > 0 && 'border-t border-border')}
              >
                <Avatar label={name} />
                <View className="flex-1 min-w-0">
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-sm text-foreground shrink" numberOfLines={1}>
                      {name}
                    </Text>
                    {m.isGuest ? (
                      <View className="rounded bg-muted px-1.5 py-0.5">
                        <Text className="text-[10px] text-muted-foreground">Guest</Text>
                      </View>
                    ) : null}
                  </View>
                  {m.user?.email && m.user.email !== name ? (
                    <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                      {m.user.email}
                    </Text>
                  ) : null}
                </View>
                <RolePicker
                  value={m.role}
                  disabled={busy}
                  onChange={(role) =>
                    void run(m.id, () => api.updateProjectMember(http, projectId, m.id, role), 'Failed to change role')
                  }
                />
                <Pressable
                  onPress={() =>
                    void run(m.id, () => api.removeProjectMember(http, projectId, m.id), 'Failed to remove member')
                  }
                  disabled={busy}
                  hitSlop={6}
                  accessibilityLabel={`Remove ${name}`}
                  className="p-1 rounded active:bg-muted"
                >
                  <Trash2 size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
            )
          })}
        </View>
      )}

      {(data?.invitations ?? []).length > 0 ? (
        <>
          <SectionTitle>Pending invitations</SectionTitle>
          <View className="rounded-lg border border-border">
            {(data?.invitations ?? []).map((inv, i) => (
              <View
                key={inv.id}
                className={cn('flex-row items-center gap-2 px-3 py-2', i > 0 && 'border-t border-border')}
              >
                <Mail size={14} className="text-muted-foreground" />
                <Text className="flex-1 min-w-0 text-sm text-foreground" numberOfLines={1}>
                  {inv.email}
                </Text>
                <Text className="text-[11px] text-muted-foreground">{roleLabel(inv.role)}</Text>
                <Pressable
                  onPress={() =>
                    void run(inv.id, () => api.revokeInvitation(http, inv.id), 'Failed to revoke invitation')
                  }
                  disabled={busyId === inv.id}
                  hitSlop={6}
                  className="px-1.5 py-1 rounded active:bg-muted"
                >
                  <Text className="text-[11px] text-destructive">Revoke</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <SectionTitle>Access through the workspace</SectionTitle>
      {inheritedAccess.length === 0 ? (
        <Text className="text-[11px] text-muted-foreground">
          {visibility === 'restricted'
            ? 'Only workspace owners and admins can open this project without being added.'
            : 'No other workspace members.'}
        </Text>
      ) : (
        <View className="rounded-lg border border-border">
          {inheritedAccess.map((m, i) => {
            const name = displayName(m.user, m.userId)
            return (
              <View
                key={m.userId}
                className={cn('flex-row items-center gap-2 px-3 py-2', i > 0 && 'border-t border-border')}
              >
                <Avatar label={name} />
                <View className="flex-1 min-w-0">
                  <Text className="text-sm text-foreground" numberOfLines={1}>
                    {name}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                    Workspace {roleLabel(m.workspaceRole)}
                  </Text>
                </View>
                <Text className="text-[11px] text-muted-foreground">
                  {m.effectiveRole ? roleLabel(m.effectiveRole) : ''}
                </Text>
              </View>
            )
          })}
        </View>
      )}
    </>
  )

  if (!embedded) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 16 }}>
        {body}
      </ScrollView>
    )
  }

  return <View className="mt-6">{body}</View>
}
