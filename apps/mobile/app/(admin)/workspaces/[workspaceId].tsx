// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Workspace Detail - Shows full workspace info, members, projects, and subscriptions.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  ArrowLeft,
  Building2,
  Users,
  FolderKanban,
  Calendar,
  ChevronRight,
  Shield,
  User,
  CreditCard,
  Key,
  Database,
  HardDrive,
  Gift,
  Plus,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'
import { Spinner } from '@/components/ui/spinner'

const API_BASE = `${API_URL}/api/admin`

interface WorkspaceMember {
  id: string
  userId: string
  role: string
  createdAt: string
  user?: { id: string; name: string | null; email: string }
}

interface WorkspaceProject {
  id: string
  name: string
  description: string | null
  status: string
  tier: string
  createdAt: string
}

interface WorkspaceSubscription {
  id: string
  planId: string
  status: string
  currentPeriodEnd: string | null
  createdAt: string
}

interface WorkspaceApiKey {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

/**
 * `GET /api/admin/storage?workspaceId=<id>` — the same detail an owner sees,
 * with the category breakdown, the rolling 30-day history and the
 * month-to-date estimate. That endpoint orders and windows the daily rows;
 * the generated workspace include does neither (`take: 50`, unordered), so the
 * detail page reads storage from here instead.
 */
interface WorkspaceStorageDetail {
  totalBytes: number
  billableBytes: number
  limitBytes: number
  projectCount: number
  percentUsed: number
  isOverLimit: boolean
  categories?: Record<string, number>
  projects?: Array<{ projectId: string; projectName: string | null; hidden: boolean; bytes: number }>
  unmeasured?: string[]
  history?: WorkspaceStorageHistoryDay[]
  month?: { billableGbMonths: number; estimatedUsd: number; mode: 'shadow' | 'enforce' }
  lastCalculatedAt: string | null
}

interface WorkspaceStorageHistoryDay {
  day: string
  totalBytes: number
  billableBytes: number
  allowanceBytes: number
  chargedUsd: number | null
  billedAt: string | null
}

interface InstanceSubscription {
  id: string
  status: string
  createdAt: string
}

interface WorkspaceGrant {
  id: string
  workspaceId: string
  freeSeats: number
  monthlyIncludedUsd: number
  /**
   * Paid plan tier this grant upgrades the workspace to (when no
   * active Stripe subscription exists). `null` = additive credit only.
   */
  planId: string | null
  startsAt: string
  expiresAt: string | null
  note: string | null
  createdAt: string
}

interface GrantsListResponse {
  workspaceGrants: WorkspaceGrant[]
  total: number
  page: number
  limit: number
}

function isGrantActive(g: WorkspaceGrant, now: Date = new Date()): boolean {
  const starts = new Date(g.startsAt)
  if (starts > now) return false
  if (g.expiresAt && new Date(g.expiresAt) <= now) return false
  return true
}

interface WorkspaceDetail {
  id: string
  name: string
  slug: string
  description: string | null
  instanceSize: string
  ssoSettings: unknown
  createdAt: string
  updatedAt: string
  members?: WorkspaceMember[]
  projects?: WorkspaceProject[]
  subscriptions?: WorkspaceSubscription[]
  apiKeys?: WorkspaceApiKey[]
  instanceSubscription?: InstanceSubscription | null
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

const INSTANCE_SIZE_COLORS: Record<string, { bg: string; text: string }> = {
  micro: { bg: 'bg-muted', text: 'text-muted-foreground' },
  small: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  medium: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-400' },
  large: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400' },
  xlarge: { bg: 'bg-pink-100 dark:bg-pink-900/30', text: 'text-pink-700 dark:text-pink-400' },
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  published: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  draft: { bg: 'bg-muted', text: 'text-muted-foreground' },
  archived: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
  active: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  trialing: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400' },
  past_due: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
  canceled: { bg: 'bg-muted', text: 'text-muted-foreground' },
}

function formatBytes(input: string | number | undefined | null): string {
  if (input == null) return '0 B'
  const n = typeof input === 'string' ? Number(input) : input
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Storage categories, in the order `storage.service.ts` measures them. */
const STORAGE_CATEGORY_LABELS: Array<{ key: string; label: string }> = [
  { key: 'project_files', label: 'Project files' },
  { key: 'repo', label: 'Repositories' },
  { key: 'assets', label: 'Assets' },
  { key: 'backups', label: 'Backups' },
  { key: 'chat_files', label: 'Chat files' },
  { key: 'workspace_root', label: 'Workspace drive' },
  { key: 'published', label: 'Published sites' },
  { key: 'bucket', label: 'Project buckets' },
  { key: 'quarantine', label: 'Quarantine (overhead)' },
  { key: 'vm_snapshots', label: 'VM snapshots (overhead)' },
]

/**
 * The workspace's storage footprint (SHO-423), from `/api/admin/storage`.
 * `billableBytes` already excludes the platform-overhead categories, so "over
 * allowance" is billable bytes minus the instance-size allowance.
 */
function WorkspaceStorageCard({ storage }: { storage: WorkspaceStorageDetail | null }) {
  if (!storage) {
    return (
      <View className="rounded-xl border border-border bg-card p-4 mb-4">
        <View className="flex-row items-center gap-2">
          <HardDrive size={14} className="text-muted-foreground" />
          <Text className="text-xs font-semibold text-foreground">Storage</Text>
        </View>
        <Text className="text-xs text-muted-foreground mt-1">Storage data unavailable.</Text>
      </View>
    )
  }

  const { totalBytes, billableBytes, limitBytes } = storage
  const overBytes = limitBytes > 0 ? Math.max(0, billableBytes - limitBytes) : 0
  const percent = limitBytes > 0 ? Math.min((totalBytes / limitBytes) * 100, 100) : 0
  const categories = storage.categories ?? {}
  const measured = STORAGE_CATEGORY_LABELS.filter((row) => Number(categories[row.key] ?? 0) > 0)
  const topProjects = (storage.projects ?? []).filter((project) => project.bytes > 0).slice(0, 5)
  const unmeasured = storage.unmeasured ?? []
  const days = [...(storage.history ?? [])].reverse().slice(0, 14)
  const maxDayBytes = days.reduce((max, row) => Math.max(max, row.totalBytes), 0)

  return (
    <View className="rounded-xl border border-border bg-card p-4 mb-4">
      <View className="flex-row items-center justify-between mb-3 gap-2">
        <View className="flex-row items-center gap-2">
          <HardDrive size={14} className="text-primary" />
          <Text className="text-xs font-semibold text-foreground">Storage</Text>
        </View>
        <Text className="text-[11px] text-muted-foreground">
          Last measured{' '}
          {storage.lastCalculatedAt ? new Date(storage.lastCalculatedAt).toLocaleString() : 'never'}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-2 mb-3">
        <View className="flex-1 min-w-[120px] rounded-lg bg-muted/50 p-2.5">
          <Text className="text-[11px] text-muted-foreground">Total</Text>
          <Text className="text-sm font-semibold text-foreground">{formatBytes(totalBytes)}</Text>
        </View>
        <View className="flex-1 min-w-[120px] rounded-lg bg-muted/50 p-2.5">
          <Text className="text-[11px] text-muted-foreground">Billable</Text>
          <Text className="text-sm font-semibold text-foreground">{formatBytes(billableBytes)}</Text>
        </View>
        <View className="flex-1 min-w-[120px] rounded-lg bg-muted/50 p-2.5">
          <Text className="text-[11px] text-muted-foreground">Allowance</Text>
          <Text className="text-sm font-semibold text-foreground">
            {limitBytes > 0 ? formatBytes(limitBytes) : '—'}
          </Text>
        </View>
        <View className="flex-1 min-w-[120px] rounded-lg bg-muted/50 p-2.5">
          <Text className="text-[11px] text-muted-foreground">Over allowance</Text>
          <Text
            className={cn(
              'text-sm font-semibold',
              overBytes > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-foreground',
            )}
          >
            {limitBytes > 0 ? formatBytes(overBytes) : '—'}
          </Text>
        </View>
      </View>

      {limitBytes > 0 && (
        <View className="mb-1">
          <View className="h-2 bg-muted rounded-full overflow-hidden">
            <View
              className={cn(
                'h-full rounded-full',
                percent > 90 ? 'bg-destructive' : percent > 70 ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${Math.max(percent, 1)}%` }}
            />
          </View>
          <Text className="text-[11px] text-muted-foreground mt-1">
            {percent.toFixed(percent >= 10 ? 0 : 1)}% of allowance
            {storage.month
              ? ` · ${storage.month.mode === 'shadow' ? 'shadow' : 'billed'} $${storage.month.estimatedUsd.toFixed(2)} MTD`
              : ''}
          </Text>
        </View>
      )}

      <Text className="text-[11px] font-medium text-muted-foreground mt-3 mb-1">By category</Text>
      {measured.length === 0 && (
        <Text className="text-xs text-muted-foreground">
          {storage.projectCount > 0 ? 'Nothing measured yet.' : 'No projects.'}
        </Text>
      )}
      {measured.map((row) => (
        <View key={row.key} className="flex-row items-center justify-between py-0.5">
          <Text className="text-xs text-muted-foreground">{row.label}</Text>
          <Text className="text-xs text-foreground">{formatBytes(Number(categories[row.key]))}</Text>
        </View>
      ))}
      {unmeasured.length > 0 && (
        <Text className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
          Not measured: {unmeasured.join(', ')}
        </Text>
      )}

      {topProjects.length > 0 && (
        <>
          <Text className="text-[11px] font-medium text-muted-foreground mt-3 mb-1">Top projects</Text>
          {topProjects.map((project) => (
            <View key={project.projectId} className="flex-row items-center justify-between py-0.5">
              <Text className="text-xs text-muted-foreground flex-1 mr-2" numberOfLines={1}>
                {project.projectName ?? 'Hidden project'}
              </Text>
              <Text className="text-xs text-foreground">{formatBytes(project.bytes)}</Text>
            </View>
          ))}
        </>
      )}

      <Text className="text-[11px] font-medium text-muted-foreground mt-3 mb-1">
        Last {days.length} day{days.length === 1 ? '' : 's'}
      </Text>
      {days.length === 0 && (
        <Text className="text-xs text-muted-foreground">No daily history yet.</Text>
      )}
      {days.map((row) => (
        <View key={row.day} className="flex-row items-center gap-2 py-0.5">
          <Text className="text-[11px] text-muted-foreground w-[74px]">{row.day}</Text>
          <View className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <View
              className={cn(
                'h-full rounded-full',
                row.allowanceBytes > 0 && row.billableBytes > row.allowanceBytes
                  ? 'bg-orange-500'
                  : 'bg-primary',
              )}
              style={{
                width: `${maxDayBytes > 0 ? Math.max((row.totalBytes / maxDayBytes) * 100, 2) : 2}%`,
              }}
            />
          </View>
          <Text className="text-[11px] text-foreground w-[64px] text-right">
            {formatBytes(row.totalBytes)}
          </Text>
        </View>
      ))}
    </View>
  )
}

export default function AdminWorkspaceDetailPage() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const isWide = width >= 900

  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  const [grants, setGrants] = useState<WorkspaceGrant[]>([])
  const [storage, setStorage] = useState<WorkspaceStorageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [userNames, setUserNames] = useState<Record<string, { name: string | null; email: string }>>({})

  const loadWorkspace = useCallback(async () => {
    if (!workspaceId) return
    const [data, grantsData, storageData] = await Promise.all([
      fetchAdminJson<WorkspaceDetail>(`/workspaces/${workspaceId}`),
      fetchAdminJson<GrantsListResponse>(
        `/workspace-grants?workspaceId=${encodeURIComponent(workspaceId)}&limit=50&orderBy=createdAt&order=desc`,
      ),
      fetchAdminJson<WorkspaceStorageDetail>(
        `/storage?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    ])
    setWorkspace(data)
    setGrants(grantsData?.workspaceGrants ?? [])
    setStorage(storageData)
    setLoading(false)
    setRefreshing(false)
  }, [workspaceId])

  useEffect(() => {
    loadWorkspace()
  }, [loadWorkspace])

  // Hydrate user display info for member list since the generated admin
  // GET doesn't include nested `user` for members.
  useEffect(() => {
    if (!workspace?.members?.length) return
    const missing = workspace.members
      .map((m) => m.userId)
      .filter((id) => id && !userNames[id])
    if (missing.length === 0) return
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(
        missing.slice(0, 30).map(async (id) => {
          const u = await fetchAdminJson<{ id: string; name: string | null; email: string }>(`/users/${id}`)
          return [id, u ? { name: u.name, email: u.email } : null] as const
        })
      )
      if (cancelled) return
      setUserNames((prev) => {
        const next = { ...prev }
        for (const [id, val] of entries) {
          if (val) next[id] = val
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [workspace?.members, userNames])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Spinner size="large" />
      </View>
    )
  }

  if (!workspace) {
    return (
      <View className="flex-1 bg-background items-center justify-center p-6">
        <Text className="text-muted-foreground">Workspace not found.</Text>
        <Pressable
          onPress={() => router.replace('/(admin)/workspaces' as any)}
          className="mt-4 flex-row items-center gap-2"
        >
          <ArrowLeft size={16} className="text-primary" />
          <Text className="text-primary text-sm">Back to Workspaces</Text>
        </Pressable>
      </View>
    )
  }

  const sizeStyle = INSTANCE_SIZE_COLORS[workspace.instanceSize] ?? INSTANCE_SIZE_COLORS.micro

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={
        isWide
          ? { paddingHorizontal: 32, paddingTop: 24, paddingBottom: 48, alignItems: 'center' }
          : { padding: 16, paddingBottom: 40 }
      }
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); loadWorkspace() }}
        />
      }
    >
      <View style={isWide ? { maxWidth: 1000, width: '100%' } : undefined}>
        <Pressable
          onPress={() => router.replace('/(admin)/workspaces' as any)}
          className={cn(
            'flex-row items-center gap-2 mb-4 self-start',
            isWide ? 'py-1.5 px-3 rounded-lg border border-border active:bg-muted/50' : 'active:opacity-60',
          )}
        >
          <ArrowLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground font-medium">Back to Workspaces</Text>
        </Pressable>

        {/* Header card */}
        <View className="rounded-xl border border-border bg-card p-5 mb-4">
          <View className="flex-row items-start gap-4">
            <View className={cn('rounded-lg bg-primary/10 items-center justify-center', isWide ? 'h-14 w-14' : 'h-12 w-12')}>
              <Building2 size={isWide ? 24 : 20} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className={cn('font-bold text-foreground', isWide ? 'text-xl' : 'text-lg')}>
                {workspace.name}
              </Text>
              <Text className="text-xs text-muted-foreground font-mono mt-0.5">
                {workspace.slug}
              </Text>
              {workspace.description && (
                <Text className="text-sm text-muted-foreground mt-2">{workspace.description}</Text>
              )}
              <View className="flex-row items-center gap-2 mt-2.5 flex-wrap">
                <View className={cn('px-2.5 py-1 rounded-full', sizeStyle.bg)}>
                  <Text className={cn('text-xs font-medium capitalize', sizeStyle.text)}>
                    {workspace.instanceSize}
                  </Text>
                </View>
                {workspace.instanceSubscription && (
                  <View className="px-2.5 py-1 rounded-full bg-muted flex-row items-center gap-1">
                    <Database size={10} className="text-muted-foreground" />
                    <Text className="text-xs font-medium text-muted-foreground">
                      Dedicated instance
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* Metadata row */}
          <View className="flex-row flex-wrap gap-4 mt-4 pt-3 border-t border-border">
            <View className="flex-row items-center gap-1.5">
              <Calendar size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                Created {new Date(workspace.createdAt).toLocaleDateString()}
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Calendar size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                Updated {new Date(workspace.updatedAt).toLocaleDateString()}
              </Text>
            </View>
          </View>

          <View className="mt-3 pt-3 border-t border-border">
            <Text className="text-xs text-muted-foreground">
              ID: <Text className="font-mono">{workspace.id}</Text>
            </Text>
          </View>
        </View>

        <WorkspaceStorageCard storage={storage} />

        {/* Stats row */}
        <View className={cn('mb-4', isWide ? 'flex-row gap-4' : 'gap-2')}>
          <StatCard
            icon={<Users size={16} className="text-foreground" />}
            label="Members"
            value={workspace.members?.length ?? 0}
            isWide={isWide}
          />
          <StatCard
            icon={<FolderKanban size={16} className="text-foreground" />}
            label="Projects"
            value={workspace.projects?.length ?? 0}
            isWide={isWide}
          />
          <StatCard
            icon={<CreditCard size={16} className="text-foreground" />}
            label="Subscriptions"
            value={workspace.subscriptions?.length ?? 0}
            isWide={isWide}
          />
          <StatCard
            icon={<Key size={16} className="text-foreground" />}
            label="API Keys"
            value={workspace.apiKeys?.length ?? 0}
            isWide={isWide}
          />
        </View>

        {/* Members + Projects */}
        <View className={cn(isWide ? 'flex-row gap-4' : 'gap-4')}>
          {/* Members */}
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <Users size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Members ({workspace.members?.length ?? 0})
              </Text>
            </View>
            {!workspace.members?.length ? (
              <Text className="text-sm text-muted-foreground">No members</Text>
            ) : (
              <View className="gap-2">
                {workspace.members.slice(0, 25).map((m) => {
                  const info = userNames[m.userId] ?? (m.user ? { name: m.user.name, email: m.user.email } : null)
                  const displayName = info?.name || info?.email || `User ${m.userId.slice(0, 8)}...`
                  return (
                    <Pressable
                      key={m.id}
                      onPress={() => router.push(`/(admin)/users/${m.userId}` as any)}
                      className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                    >
                      <View className="flex-row items-center gap-2 flex-1 min-w-0">
                        <View className="h-7 w-7 rounded-full bg-primary/10 items-center justify-center">
                          <Text className="text-[10px] font-medium text-primary">
                            {displayName.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        <View className="flex-1 min-w-0">
                          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                            {displayName}
                          </Text>
                          {info?.email && info?.name && (
                            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                              {info.email}
                            </Text>
                          )}
                        </View>
                      </View>
                      <View className="flex-row items-center gap-2">
                        <View className={cn(
                          'flex-row items-center gap-1 px-2 py-0.5 rounded-full',
                          m.role === 'owner' ? 'bg-primary/10' : 'bg-muted',
                        )}>
                          {m.role === 'owner' || m.role === 'admin' ? (
                            <Shield size={10} className={m.role === 'owner' ? 'text-primary' : 'text-muted-foreground'} />
                          ) : (
                            <User size={10} className="text-muted-foreground" />
                          )}
                          <Text className={cn(
                            'text-[10px] font-medium capitalize',
                            m.role === 'owner' ? 'text-primary' : 'text-muted-foreground',
                          )}>
                            {m.role}
                          </Text>
                        </View>
                        <ChevronRight size={14} className="text-muted-foreground" />
                      </View>
                    </Pressable>
                  )
                })}
              </View>
            )}
          </View>

          {/* Projects */}
          <View className={cn('rounded-xl border border-border bg-card p-4', isWide ? 'flex-1' : '')}>
            <View className="flex-row items-center gap-2 mb-3">
              <FolderKanban size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Projects ({workspace.projects?.length ?? 0})
              </Text>
            </View>
            {!workspace.projects?.length ? (
              <Text className="text-sm text-muted-foreground">No projects</Text>
            ) : (
              <View className="gap-2">
                {workspace.projects.slice(0, 25).map((p) => {
                  const statusStyle = STATUS_COLORS[p.status] ?? STATUS_COLORS.draft
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => router.push(`/(admin)/admin/projects/${p.id}` as any)}
                      className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                    >
                      <View className="flex-1 min-w-0 mr-2">
                        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                          {p.name}
                        </Text>
                        {p.description && (
                          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                            {p.description}
                          </Text>
                        )}
                      </View>
                      <View className="flex-row items-center gap-2">
                        <View className={cn('px-2 py-0.5 rounded-full', statusStyle.bg)}>
                          <Text className={cn('text-[10px] font-medium capitalize', statusStyle.text)}>
                            {p.status}
                          </Text>
                        </View>
                        <ChevronRight size={14} className="text-muted-foreground" />
                      </View>
                    </Pressable>
                  )
                })}
              </View>
            )}
          </View>
        </View>

        {/* Subscriptions */}
        {!!workspace.subscriptions?.length && (
          <View className="rounded-xl border border-border bg-card p-4 mt-4">
            <View className="flex-row items-center gap-2 mb-3">
              <CreditCard size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Subscriptions ({workspace.subscriptions.length})
              </Text>
            </View>
            <View className="gap-2">
              {workspace.subscriptions.map((s) => {
                const statusStyle = STATUS_COLORS[s.status] ?? STATUS_COLORS.canceled
                return (
                  <View
                    key={s.id}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <View className="flex-1 min-w-0 mr-2">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {s.planId}
                      </Text>
                      {s.currentPeriodEnd && (
                        <Text className="text-xs text-muted-foreground">
                          Renews {new Date(s.currentPeriodEnd).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                    <View className={cn('px-2 py-0.5 rounded-full', statusStyle.bg)}>
                      <Text className={cn('text-[10px] font-medium capitalize', statusStyle.text)}>
                        {s.status}
                      </Text>
                    </View>
                  </View>
                )
              })}
            </View>
          </View>
        )}

        {/* Credit grants */}
        <View className="rounded-xl border border-border bg-card p-4 mt-4">
          <View className="flex-row items-center justify-between mb-3">
            <View className="flex-row items-center gap-2">
              <Gift size={16} className="text-foreground" />
              <Text className="text-sm font-semibold text-foreground">
                Credit grants ({grants.length})
              </Text>
            </View>
            <Pressable
              onPress={() =>
                router.push(
                  `/(admin)/grants/new?workspaceId=${encodeURIComponent(workspace.id)}` as any,
                )
              }
              className="flex-row items-center gap-1.5 bg-primary/10 px-2.5 py-1.5 rounded-md active:bg-primary/20"
            >
              <Plus size={12} className="text-primary" />
              <Text className="text-xs font-medium text-primary">New grant</Text>
            </Pressable>
          </View>
          {grants.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              No grants. Use "New grant" to give this workspace free seats, monthly USD, or a plan upgrade.
            </Text>
          ) : (
            <View className="gap-2">
              {grants.map((g) => {
                const active = isGrantActive(g)
                return (
                  <Pressable
                    key={g.id}
                    onPress={() => router.push(`/(admin)/grants/${g.id}` as any)}
                    className="flex-row items-center justify-between p-3 rounded-lg bg-muted/50 active:bg-muted"
                  >
                    <View className="flex-1 min-w-0 mr-2">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {g.freeSeats} free seat{g.freeSeats === 1 ? '' : 's'} + ${g.monthlyIncludedUsd.toFixed(0)}/mo
                      </Text>
                      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                        {g.note
                          ? g.note
                          : g.expiresAt
                            ? `Expires ${new Date(g.expiresAt).toLocaleDateString()}`
                            : 'No expiry'}
                      </Text>
                    </View>
                    {g.planId && (
                      <View className="px-2 py-0.5 rounded-full mr-2 bg-primary/10">
                        <Text className="text-[10px] font-medium capitalize text-primary">
                          {g.planId}
                        </Text>
                      </View>
                    )}
                    <View
                      className={cn(
                        'px-2 py-0.5 rounded-full mr-2',
                        active
                          ? 'bg-green-100 dark:bg-green-900/30'
                          : 'bg-muted',
                      )}
                    >
                      <Text
                        className={cn(
                          'text-[10px] font-medium',
                          active
                            ? 'text-green-700 dark:text-green-400'
                            : 'text-muted-foreground',
                        )}
                      >
                        {active ? 'Active' : 'Expired'}
                      </Text>
                    </View>
                    <ChevronRight size={14} className="text-muted-foreground" />
                  </Pressable>
                )
              })}
            </View>
          )}
        </View>
      </View>
    </ScrollView>
  )
}

function StatCard({
  icon,
  label,
  value,
  isWide,
}: {
  icon: React.ReactNode
  label: string
  value: number
  isWide: boolean
}) {
  return (
    <View
      className={cn(
        'rounded-xl border border-border bg-card p-3',
        isWide ? 'flex-1' : 'flex-row items-center justify-between',
      )}
    >
      <View className={cn('flex-row items-center gap-2', isWide ? 'mb-1' : '')}>
        {icon}
        <Text className="text-xs text-muted-foreground font-medium">{label}</Text>
      </View>
      <Text className={cn('font-bold text-foreground', isWide ? 'text-2xl' : 'text-lg')}>
        {value}
      </Text>
    </View>
  )
}
