// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Layout - Responsive admin shell with persistent sidebar on desktop.
 *
 * Wide screens (>= 900px): persistent sidebar + scrollable content area
 * Narrow screens (< 900px): hamburger header + drawer sidebar overlay
 *
 * Auth guard checks admin role via /api/me and redirects non-admins.
 * Wraps in DomainProvider since (admin) is a separate route group from (app).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator, useWindowDimensions } from 'react-native'
import { Slot, usePathname, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  LayoutDashboard,
  Users,
  Building2,
  FolderKanban,
  BarChart3,
  Server,
  Settings,
  ArrowLeft,
  Shield,
  Menu,
  X,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { DomainProvider, useDomainHttp } from '../../contexts/domain'
import { api, API_URL } from '../../lib/api'
import { usePlatformConfig } from '../../lib/platform-config'

type UserRole = 'user' | 'super_admin'

const BASE_NAV_ITEMS = [
  { href: '/(admin)', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/(admin)/users', icon: Users, label: 'Users' },
  { href: '/(admin)/workspaces', icon: Building2, label: 'Workspaces' },
  { href: '/(admin)/projects', icon: FolderKanban, label: 'Projects' },
  { href: '/(admin)/analytics', icon: BarChart3, label: 'Analytics' },
  { href: '/(admin)/infrastructure', icon: Server, label: 'Infrastructure' },
] as const

const LOCAL_NAV_ITEM = { href: '/(admin)/settings' as const, icon: Settings, label: 'AI Settings' }

const LOCAL_NAV_ITEMS = [
  { href: '/(admin)', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/(admin)/users', icon: Users, label: 'Users' },
  { href: '/(admin)/workspaces', icon: Building2, label: 'Workspaces' },
  { href: '/(admin)/projects', icon: FolderKanban, label: 'Projects' },
  { href: '/(admin)/analytics', icon: BarChart3, label: 'Analytics' },
  { href: '/(admin)/settings' as const, icon: Settings, label: 'AI Settings' },
] as const

function useAdminCheck() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const http = useDomainHttp()
  const [role, setRole] = useState<UserRole | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (authLoading) return
    if (!isAuthenticated) {
      setChecking(false)
      return
    }
    let cancelled = false
    setChecking(true)
    api.getMe(http)
      .then((data) => {
        if (!cancelled && data.ok && data.data?.role) {
          setRole(data.data.role as UserRole)
        }
      })
      .catch((e) => console.error('[AdminLayout] Failed to verify admin role:', e))
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => { cancelled = true }
  }, [http, isAuthenticated, authLoading, user?.id])

  return {
    isSuperAdmin: role === 'super_admin',
    isPending: authLoading || checking,
    isAuthenticated,
    userEmail: user?.email,
    userName: user?.name,
  }
}

type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown'

function useInfraHealth(enabled: boolean): HealthStatus {
  const [status, setStatus] = useState<HealthStatus>('unknown')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!enabled) return
    const check = async () => {
      try {
        const res = await fetch(`${API_URL}/api/admin/analytics/infra-current`, {
          credentials: 'include',
        })
        if (!res.ok) { setStatus('unknown'); return }
        const json = await res.json()
        const d = json.data
        const cluster = d?.live?.cluster ?? d?.snapshot
        if (!cluster) { setStatus('unknown'); return }
        const pct = cluster.totalPodSlots > 0
          ? (cluster.usedPodSlots / cluster.totalPodSlots) * 100
          : 0
        setStatus(pct >= 90 ? 'critical' : pct >= 70 ? 'degraded' : 'healthy')
      } catch {
        setStatus('unknown')
      }
    }
    check()
    timerRef.current = setInterval(check, 60_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [enabled])

  return status
}

function isNavActive(pathname: string, href: string): boolean {
  if (href === '/(admin)') {
    return pathname === '/' || pathname === '' || pathname === '/(admin)' || pathname === '/index'
  }
  const clean = href.replace('/(admin)', '')
  return pathname.startsWith(clean)
}

const HEALTH_DOT_COLOR: Record<HealthStatus, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-yellow-500',
  critical: 'bg-red-500',
  unknown: 'bg-muted-foreground',
}

function AdminSidebar({
  userName,
  userEmail,
  isDrawer,
  onClose,
  infraHealth = 'unknown',
}: {
  userName?: string | null
  userEmail?: string | null
  isDrawer?: boolean
  onClose?: () => void
  infraHealth?: HealthStatus
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { features, localMode } = usePlatformConfig()
  const NAV_ITEMS = localMode ? LOCAL_NAV_ITEMS : features.billing ? BASE_NAV_ITEMS : [...BASE_NAV_ITEMS, LOCAL_NAV_ITEM]

  const handleNav = useCallback((href: string) => {
    router.push(href as any)
    onClose?.()
  }, [router, onClose])

  const sidebar = (
    <View className={cn(
      'bg-card border-r border-border h-full',
      isDrawer ? 'w-[260px]' : 'w-[240px]',
    )}>
      {/* Header */}
      <View className="px-4 pt-5 pb-4 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5">
            <View className="h-8 w-8 rounded-lg bg-primary/10 items-center justify-center">
              <Shield size={16} className="text-primary" />
            </View>
            <View>
              <Text className="text-sm font-bold text-foreground">Admin</Text>
              <Text className="text-[10px] text-muted-foreground">Super Admin Portal</Text>
            </View>
          </View>
          {isDrawer && (
            <Pressable onPress={onClose} className="p-1.5 rounded-md active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      </View>

      {/* Nav Items */}
      <View className="flex-1 px-3 py-3 gap-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = isNavActive(pathname, item.href)
          return (
            <Pressable
              key={item.href}
              onPress={() => handleNav(item.href)}
              className={cn(
                'flex-row items-center gap-3 px-3 py-2.5 rounded-lg',
                active
                  ? 'bg-primary/10'
                  : 'active:bg-muted/50'
              )}
            >
              <Icon
                size={18}
                className={active ? 'text-primary' : 'text-muted-foreground'}
              />
              <Text
                className={cn(
                  'text-sm font-medium flex-1',
                  active ? 'text-primary' : 'text-foreground'
                )}
              >
                {item.label}
              </Text>
              {item.label === 'Infrastructure' && infraHealth !== 'unknown' && (
                <View className={cn('h-2 w-2 rounded-full', HEALTH_DOT_COLOR[infraHealth])} />
              )}
            </Pressable>
          )
        })}
      </View>

      {/* Footer */}
      <View className="px-3 pb-4 gap-2">
        <Pressable
          onPress={() => { router.replace('/(app)'); onClose?.() }}
          className="flex-row items-center gap-3 px-3 py-2.5 rounded-lg active:bg-muted/50"
        >
          <ArrowLeft size={18} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-muted-foreground">Back to App</Text>
        </Pressable>

        <View className="border-t border-border pt-3 px-1">
          <View className="flex-row items-center gap-2.5">
            <View className="h-8 w-8 rounded-full bg-primary/10 items-center justify-center">
              <Text className="text-xs font-semibold text-primary">
                {userName?.charAt(0)?.toUpperCase() || 'A'}
              </Text>
            </View>
            <View className="flex-1 min-w-0">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {userName || 'Admin'}
              </Text>
              <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                {userEmail}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  )

  if (!isDrawer) return sidebar

  return (
    <View className="absolute inset-0 z-50 flex-row" style={{ elevation: 10 }}>
      <Pressable
        onPress={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <View className="z-10">
        {sidebar}
      </View>
    </View>
  )
}

function MobileHeader({ onMenuPress, title }: { onMenuPress: () => void; title: string }) {
  return (
    <View className="flex-row items-center h-12 px-3 border-b border-border bg-card">
      <Pressable onPress={onMenuPress} className="p-2 -ml-1 rounded-md active:bg-muted">
        <Menu size={20} className="text-foreground" />
      </Pressable>
      <View className="flex-row items-center gap-2 ml-2">
        <Shield size={14} className="text-primary" />
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
      </View>
    </View>
  )
}

function getPageTitle(pathname: string): string {
  if (pathname.startsWith('/users/')) return 'User Detail'
  if (pathname.startsWith('/users') || pathname === '/users') return 'Users'
  if (pathname.startsWith('/workspaces/')) return 'Workspace Detail'
  if (pathname.includes('workspaces')) return 'Workspaces'
  if (pathname.startsWith('/projects/')) return 'Project Detail'
  if (pathname.includes('projects')) return 'Projects'
  if (pathname.includes('analytics')) return 'Analytics'
  if (pathname.includes('infrastructure')) return 'Infrastructure'
  return 'Dashboard'
}

export default function AdminLayout() {
  return (
    <DomainProvider>
      <AdminLayoutInner />
    </DomainProvider>
  )
}

function AdminLayoutInner() {
  const router = useRouter()
  const pathname = usePathname()
  const { width } = useWindowDimensions()
  const isWide = width >= 900
  const { isSuperAdmin, isPending, isAuthenticated, userEmail, userName } = useAdminCheck()
  const infraHealth = useInfraHealth(isSuperAdmin)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (!isPending && (!isAuthenticated || !isSuperAdmin)) {
      router.replace('/(app)')
    }
  }, [isPending, isAuthenticated, isSuperAdmin, router])

  useEffect(() => {
    if (isWide) setDrawerOpen(false)
  }, [isWide])

  if (isPending) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground mt-3 text-sm">
            Verifying admin access...
          </Text>
        </View>
      </SafeAreaView>
    )
  }

  if (!isAuthenticated || !isSuperAdmin) return null

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 flex-row">
        {isWide && (
          <AdminSidebar userName={userName} userEmail={userEmail} infraHealth={infraHealth} />
        )}

        <View className="flex-1">
          {!isWide && (
            <MobileHeader
              onMenuPress={() => setDrawerOpen(true)}
              title={getPageTitle(pathname)}
            />
          )}
          <View className="flex-1">
            <Slot />
          </View>
        </View>
      </View>

      {!isWide && drawerOpen && (
        <AdminSidebar
          userName={userName}
          userEmail={userEmail}
          isDrawer
          onClose={() => setDrawerOpen(false)}
          infraHealth={infraHealth}
        />
      )}
    </SafeAreaView>
  )
}
