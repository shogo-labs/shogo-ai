// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Layout - Responsive admin shell with persistent sidebar on desktop.
 *
 * Wide web (>= 900px): persistent sidebar + scrollable content.
 * Narrow web: hamburger header + overlay drawer.
 * Native phone: two-layer sheet drawer (sidebar underneath, screen slides).
 *
 * Auth guard checks admin role via /api/me and redirects non-admins.
 * Wraps in DomainProvider since (admin) is a separate route group from (app).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
  Platform,
  Animated,
  StyleSheet,
} from 'react-native'
import { Slot, usePathname, useRouter } from 'expo-router'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  nativeDrawerPanelWidth,
  snapNativeDrawer,
  useNativeDrawerSheetSwipe,
  useNativeDrawerSheetStyle,
  nativeDrawerUnderlayStyle,
  nativeDrawerTopInset,
  nativeDrawerSideInset,
  nativeDrawerFooterInset,
  NATIVE_DRAWER_UNDERLAY_BACKGROUND,
} from '../../lib/use-native-drawer-swipe'
import {
  LayoutDashboard,
  Users,
  Building2,
  FolderKanban,
  BarChart3,
  Server,
  Settings,
  BrainCircuit,
  ArrowLeft,
  Shield,
  Menu,
  X,
  FlaskConical,
  Mic,
  ScrollText,
  Gift,
  Heart,
  Store,
  KeyRound,
  Sparkles,
  Clapperboard,
  Activity,
  Wallet,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { DomainProvider, useDomainHttp } from '../../contexts/domain'
import { api, API_URL } from '../../lib/api'
import { usePlatformConfig } from '../../lib/platform-config'

type UserRole = 'user' | 'super_admin'

/**
 * Nav item access markers:
 *   - `scope`     → visible to super admins OR holders of that admin scope
 *   - `scopes`    → visible to super admins OR holders of *any* listed scope
 *   - `anyAdmin`  → visible to anyone with *some* admin access (e.g. Dashboard)
 *   - neither     → super_admin only
 */
type AdminNavItem = {
  href: string
  icon: any
  label: string
  scope?: string
  scopes?: readonly string[]
  anyAdmin?: boolean
}

type AdminNavSection = {
  title: string
  items: readonly AdminNavItem[]
}

/**
 * Sidebar nav, grouped into labeled sections. A section is hidden entirely when
 * the current user can see none of its items (see canSeeNavItem), so a scoped
 * analytics/creators admin sees only Overview + Growth & Marketing.
 */
const NAV_SECTIONS: readonly AdminNavSection[] = [
  {
    title: 'Overview',
    items: [
      { href: '/(admin)', icon: LayoutDashboard, label: 'Dashboard', scopes: ['analytics:read', 'marketing:read', 'ai:read'] },
    ],
  },
  {
    title: 'Growth & Marketing',
    items: [
      { href: '/(admin)/analytics', icon: BarChart3, label: 'Marketing Analytics', scopes: ['analytics:read', 'marketing:read'] },
      { href: '/(admin)/creators', icon: Sparkles, label: 'Creators', scopes: ['creators:read', 'creators:write'] },
      { href: '/(admin)/affiliate-content', icon: Clapperboard, label: 'Affiliate CPM', scope: 'creators:write' },
      { href: '/(admin)/affiliate-payouts', icon: Wallet, label: 'Affiliate payouts', scope: 'creators:write' },
    ],
  },
  {
    title: 'Marketplace',
    items: [
      { href: '/(admin)/marketplace', icon: Store, label: 'Marketplace' },
    ],
  },
  {
    title: 'Platform',
    items: [
      { href: '/(admin)/users', icon: Users, label: 'Users' },
      { href: '/(admin)/workspaces', icon: Building2, label: 'Workspaces' },
      { href: '/(admin)/projects', icon: FolderKanban, label: 'Projects' },
    ],
  },
  {
    title: 'Billing',
    items: [
      { href: '/(admin)/grants', icon: Gift, label: 'Credit grants' },
      { href: '/(admin)/license-keys', icon: KeyRound, label: 'License keys' },
    ],
  },
  {
    title: 'Infrastructure',
    items: [
      { href: '/(admin)/infrastructure', icon: Server, label: 'Infrastructure' },
      { href: '/(admin)/heartbeats', icon: Heart, label: 'Heartbeats' },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/(admin)/ai-analytics', icon: Activity, label: 'AI Analytics', scopes: ['analytics:read', 'ai:read'] },
      { href: '/(admin)/evals', icon: FlaskConical, label: 'Evals' },
      { href: '/(admin)/general', icon: Settings, label: 'General' },
      { href: '/(admin)/settings', icon: BrainCircuit, label: 'AI' },
    ],
  },
]

/** Flattened nav items, used by the portal entry + per-route access guard. */
const ALL_NAV_ITEMS: readonly AdminNavItem[] = NAV_SECTIONS.flatMap((s) => s.items)

/** Can the current user see this nav item / access this admin surface? */
function canSeeNavItem(item: AdminNavItem, isSuperAdmin: boolean, scopes: string[]): boolean {
  if (isSuperAdmin) return true
  if (item.anyAdmin) return true
  if (item.scopes) return item.scopes.some((s) => scopes.includes(s))
  if (item.scope) return scopes.includes(item.scope)
  return false
}

const LOCAL_MAIN_ITEMS = [
  { href: '/(admin)/projects', icon: FolderKanban, label: 'Projects' },
  { href: '/(admin)/analytics', icon: BarChart3, label: 'Marketing Analytics' },
  { href: '/(admin)/ai-analytics', icon: Activity, label: 'AI Analytics' },
  { href: '/(admin)/heartbeats', icon: Heart, label: 'Heartbeats' },
  { href: '/(admin)/evals', icon: FlaskConical, label: 'Evals' },
] as const

const LOCAL_SETTINGS_ITEMS = [
  { href: '/(admin)/general' as const, icon: Settings, label: 'General' },
  { href: '/(admin)/meetings' as const, icon: Mic, label: 'Meetings' },
  { href: '/(admin)/logs' as const, icon: ScrollText, label: 'Logs' },
  { href: '/(admin)/settings' as const, icon: BrainCircuit, label: 'AI' },
] as const

function useAdminCheck() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const http = useDomainHttp()
  const [role, setRole] = useState<UserRole | null>(null)
  const [scopes, setScopes] = useState<string[]>([])
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
          setScopes(Array.isArray(data.data.adminScopes) ? data.data.adminScopes : [])
        }
      })
      .catch((e) => console.error('[AdminLayout] Failed to verify admin role:', e))
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => { cancelled = true }
  }, [http, isAuthenticated, authLoading, user?.id])

  const isSuperAdmin = role === 'super_admin'

  return {
    isSuperAdmin,
    scopes,
    // Portal access: full super admins OR users granted at least one scope.
    hasAdminAccess: isSuperAdmin || scopes.length > 0,
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
  isNativeDrawer,
  onClose,
  infraHealth = 'unknown',
  isSuperAdmin = true,
  scopes = [],
}: {
  userName?: string | null
  userEmail?: string | null
  isDrawer?: boolean
  isNativeDrawer?: boolean
  onClose?: () => void
  infraHealth?: HealthStatus
  isSuperAdmin?: boolean
  scopes?: string[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { localMode } = usePlatformConfig()
  const visibleSections = NAV_SECTIONS
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => canSeeNavItem(item, isSuperAdmin, scopes)),
    }))
    .filter((section) => section.items.length > 0)

  const handleNav = useCallback((href: string) => {
    router.push(href as any)
    onClose?.()
  }, [router, onClose])

  const renderNavRow = (item: AdminNavItem | { href: string; icon: any; label: string }) => {
    const Icon = item.icon
    const active = isNavActive(pathname, item.href)
    return (
      <Pressable
        key={item.href}
        onPress={() => handleNav(item.href)}
        role="button"
        accessibilityLabel={item.label}
        className={cn(
          'flex-row items-center rounded-md px-2',
          isNativeDrawer ? 'min-h-11 gap-2.5 py-2' : 'gap-2 py-1',
          active ? 'bg-accent' : 'active:bg-accent/50',
        )}
      >
        <Icon
          size={isNativeDrawer ? 18 : 12}
          className={active ? 'text-foreground' : 'text-muted-foreground'}
        />
        <Text className={cn(isNativeDrawer ? 'text-base flex-1' : 'text-xs flex-1', active ? 'text-foreground' : 'text-muted-foreground')}>
          {item.label}
        </Text>
        {item.label === 'Infrastructure' && infraHealth !== 'unknown' && (
          <View className={cn('rounded-full', isNativeDrawer ? 'h-2.5 w-2.5' : 'h-2 w-2', HEALTH_DOT_COLOR[infraHealth])} />
        )}
      </Pressable>
    )
  }

  const sectionLabelClass = cn(
    'px-1 pb-1 font-semibold uppercase tracking-wider text-muted-foreground',
    isNativeDrawer ? 'text-sm' : 'text-[11px]',
  )

  const sidebar = (
    <View
      className={cn('h-full', isNativeDrawer ? 'w-full' : 'w-64 bg-card border-r border-border')}
      style={
        isNativeDrawer
          ? {
              backgroundColor: NATIVE_DRAWER_UNDERLAY_BACKGROUND,
              paddingLeft: nativeDrawerSideInset(insets.left),
              paddingRight: 4,
            }
          : undefined
      }
    >
      {isNativeDrawer ? <View style={{ height: nativeDrawerTopInset(insets.top) }} /> : null}
      <View className={cn(
        'border-b border-border flex-row items-center justify-between px-3',
        isNativeDrawer ? 'h-16' : 'py-2',
      )}>
        <View className={cn('flex-row items-center', isNativeDrawer ? 'gap-3' : 'gap-2')}>
          <Shield size={isNativeDrawer ? 18 : 12} className="text-primary" />
          <View>
            <Text className={cn('font-semibold text-foreground', isNativeDrawer ? 'text-lg' : 'text-sm')}>Admin</Text>
            <Text className={cn('text-muted-foreground', isNativeDrawer ? 'text-sm' : 'text-xs')}>
              {isSuperAdmin ? 'Super Admin Portal' : 'Admin Portal'}
            </Text>
          </View>
        </View>
        {isDrawer && !isNativeDrawer && (
          <Pressable onPress={onClose} className="h-8 w-8 items-center justify-center rounded-md active:bg-muted">
            <X size={12} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      <ScrollView className="flex-1 pt-2" contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }} showsVerticalScrollIndicator={false}>
        {localMode ? (
          <View className="gap-0.5 px-2">
            {LOCAL_MAIN_ITEMS.map(renderNavRow)}
            <View className="mx-1 mt-4 mb-2 border-t border-border" />
            <Text className={sectionLabelClass}>Settings</Text>
            {LOCAL_SETTINGS_ITEMS.map(renderNavRow)}
          </View>
        ) : (
          visibleSections.map((section, idx) => (
            <View key={section.title} className={cn('gap-0.5 px-2', idx > 0 && (isNativeDrawer ? 'mt-5' : 'mt-3'))}>
              <Text className={sectionLabelClass}>{section.title}</Text>
              {section.items.map(renderNavRow)}
            </View>
          ))
        )}
      </ScrollView>

      <View
        className="border-t border-border p-2 gap-0.5"
        style={isNativeDrawer ? { paddingBottom: nativeDrawerFooterInset(insets.bottom) } : undefined}
      >
        <Pressable
          onPress={() => { router.replace('/(app)'); onClose?.() }}
          role="link"
          accessibilityLabel="Back to App"
          className={cn(
            'flex-row items-center rounded-md px-2 active:bg-accent/50',
            isNativeDrawer ? 'min-h-11 gap-2.5 py-2' : 'gap-2 py-1',
          )}
        >
          <ArrowLeft size={isNativeDrawer ? 18 : 12} className="text-muted-foreground" />
          <Text className={cn('text-muted-foreground', isNativeDrawer ? 'text-base' : 'text-xs')}>Back to App</Text>
        </Pressable>

        <View className={cn('flex-row items-center px-2', isNativeDrawer ? 'min-h-14 gap-3 py-2' : 'gap-2 py-1.5')}>
          <View className={cn('rounded bg-primary/20 items-center justify-center', isNativeDrawer ? 'h-11 w-11' : 'h-7 w-7')}>
            <Text className={cn('font-bold text-primary', isNativeDrawer ? 'text-base' : 'text-[11px]')}>
              {userName?.charAt(0)?.toUpperCase() || 'A'}
            </Text>
          </View>
          <View className="flex-1 min-w-0">
            <Text className={cn('text-foreground', isNativeDrawer ? 'text-base' : 'text-sm')} numberOfLines={1}>
              {userName || 'Admin'}
            </Text>
            <Text className={cn('text-muted-foreground', isNativeDrawer ? 'text-sm' : 'text-xs')} numberOfLines={1}>
              {userEmail}
            </Text>
          </View>
        </View>
      </View>
    </View>
  )

  if (!isDrawer) return sidebar

  return (
    <View style={overlayStyles.root}>
      <Pressable
        onPress={onClose}
        style={overlayStyles.backdrop}
        accessibilityLabel="Dismiss menu"
        accessibilityRole="button"
      />
      <View style={overlayStyles.panel}>
        {sidebar}
      </View>
    </View>
  )
}

function MobileHeader({
  onMenuPress,
  title,
  menuOpen = false,
  isNative = false,
}: {
  onMenuPress: () => void
  title: string
  menuOpen?: boolean
  isNative?: boolean
}) {
  const insets = useSafeAreaInsets()
  if (isNative) {
    return (
      <View
        style={{
          paddingTop: insets.top + 6,
          paddingBottom: 6,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Pressable
          onPress={onMenuPress}
          accessibilityRole="button"
          accessibilityLabel={menuOpen ? 'Close menu' : 'Open menu'}
          hitSlop={4}
          className="h-10 w-10 items-center justify-center rounded-full bg-muted"
        >
          <Menu size={22} className="text-foreground" />
        </Pressable>
        <Text className="flex-1 px-3 text-center text-base font-semibold text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <View className="h-10 w-10" />
      </View>
    )
  }

  return (
    <View className="flex-row items-center h-12 px-3 border-b border-border bg-card">
      <Pressable onPress={onMenuPress} role="button" accessibilityLabel="Open menu" className="p-2 -ml-1 rounded-md active:bg-muted">
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
  if (pathname.startsWith('/grants/')) return 'Grant Detail'
  if (pathname.includes('grants')) return 'Credit grants'
  if (pathname.startsWith('/marketplace/listing/')) return 'Listing Detail'
  if (pathname.startsWith('/marketplace/payouts')) return 'Marketplace Payouts'
  if (pathname.startsWith('/marketplace/listings')) return 'Marketplace Listings'
  if (pathname.startsWith('/marketplace')) return 'Marketplace Review'
  if (pathname.startsWith('/projects/')) return 'Project Detail'
  if (pathname.includes('projects')) return 'Projects'
  if (pathname.includes('ai-analytics')) return 'AI Analytics'
  if (pathname.includes('analytics')) return 'Marketing Analytics'
  if (pathname.startsWith('/creators/')) return 'Creator Profile'
  if (pathname.includes('creators')) return 'Creators'
  if (pathname.includes('affiliate-payouts')) return 'Affiliate Payouts'
  if (pathname.includes('affiliate-content')) return 'Affiliate CPM'
  if (pathname.includes('infrastructure')) return 'Infrastructure'
  if (pathname.includes('heartbeats')) return 'Heartbeats'
  if (pathname.startsWith('/evals/')) return 'Eval Detail'
  if (pathname.includes('evals')) return 'Evals'
  if (pathname.includes('/logs')) return 'Logs'
  if (pathname.includes('meetings')) return 'Meetings'
  if (pathname.includes('general')) return 'General'
  if (pathname.includes('settings')) return 'AI Settings'
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
  const isNativeApp = Platform.OS !== 'web'
  const isWide = !isNativeApp && width >= 900
  const nativeSheetDrawer = isNativeApp
  const nativeDrawerWidth = nativeDrawerPanelWidth(width)
  const drawerProgress = useRef(new Animated.Value(0)).current
  const { isSuperAdmin, scopes, hasAdminAccess, isPending, isAuthenticated, userEmail, userName } = useAdminCheck()
  const { localMode } = usePlatformConfig()
  const infraHealth = useInfraHealth(isSuperAdmin)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const resetDrawer = useCallback(() => {
    drawerProgress.setValue(0)
    setDrawerOpen(false)
  }, [drawerProgress])
  const openDrawer = useCallback(() => {
    setDrawerOpen(true)
    snapNativeDrawer(drawerProgress, true)
  }, [drawerProgress])
  const closeDrawer = useCallback(() => {
    snapNativeDrawer(drawerProgress, false, (open) => {
      if (!open) resetDrawer()
    })
  }, [drawerProgress, resetDrawer])
  const toggleDrawer = useCallback(() => {
    if (drawerOpen) closeDrawer()
    else if (nativeSheetDrawer) openDrawer()
    else setDrawerOpen(true)
  }, [closeDrawer, drawerOpen, nativeSheetDrawer, openDrawer])

  const sheetSwipeHandlers = useNativeDrawerSheetSwipe({
    enabled: nativeSheetDrawer,
    drawerWidth: nativeDrawerWidth,
    drawerProgress,
    isOpen: drawerOpen,
    onOpenChange: setDrawerOpen,
  })
  const { sheetStyle, sheetClipStyle } = useNativeDrawerSheetStyle(drawerProgress, nativeDrawerWidth)

  const sidebarProps = {
    userName,
    userEmail,
    infraHealth,
    isSuperAdmin,
    scopes,
  } as const

  // Portal entry: must be authenticated AND have some admin access.
  useEffect(() => {
    if (!isPending && (!isAuthenticated || !hasAdminAccess)) {
      router.replace('/(app)')
    }
  }, [isPending, isAuthenticated, hasAdminAccess, router])

  // Per-route guard: a partial admin who deep-links to a page they lack
  // permission for is bounced to their first permitted page (the backend
  // also 403s those endpoints — this is the matching UX).
  useEffect(() => {
    if (isPending || !isAuthenticated || !hasAdminAccess || isSuperAdmin || localMode) return
    const permitted = ALL_NAV_ITEMS.filter((item) =>
      canSeeNavItem(item, isSuperAdmin, scopes),
    )
    const onPermitted = permitted.some((item) => isNavActive(pathname, item.href))
    if (!onPermitted && permitted.length > 0) {
      router.replace(permitted[0].href as any)
    }
  }, [isPending, isAuthenticated, hasAdminAccess, isSuperAdmin, localMode, scopes, pathname, router])

  useEffect(() => {
    if (localMode && !isPending && hasAdminAccess) {
      const p = pathname
      if (p === '/' || p === '' || p === '/(admin)' || p === '/index') {
        router.replace('/(admin)/projects' as any)
      }
    }
  }, [localMode, isPending, hasAdminAccess, pathname, router])

  useEffect(() => {
    if (isWide) resetDrawer()
  }, [isWide, resetDrawer])

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

  if (!isAuthenticated || !hasAdminAccess) return null

  return (
    <SafeAreaView
      className="flex-1 bg-background"
      style={nativeSheetDrawer ? { backgroundColor: NATIVE_DRAWER_UNDERLAY_BACKGROUND } : undefined}
      edges={nativeSheetDrawer ? ['left', 'right'] : undefined}
    >
      <View className="flex-1 flex-row">
        {isWide && <AdminSidebar {...sidebarProps} />}

        <View style={{ flex: 1, overflow: 'hidden' }} collapsable={false}>
          {nativeSheetDrawer ? (
            <View
              pointerEvents={drawerOpen ? 'auto' : 'none'}
              accessibilityElementsHidden={!drawerOpen}
              importantForAccessibility={drawerOpen ? 'auto' : 'no-hide-descendants'}
              style={nativeDrawerUnderlayStyle(nativeDrawerWidth)}
            >
              <AdminSidebar {...sidebarProps} isNativeDrawer onClose={closeDrawer} />
            </View>
          ) : null}
          <Animated.View
            collapsable={false}
            {...sheetSwipeHandlers}
            style={[{ flex: 1, zIndex: 1 }, nativeSheetDrawer ? sheetStyle : undefined]}
          >
            <Animated.View style={nativeSheetDrawer ? sheetClipStyle : { flex: 1, overflow: 'hidden' }}>
              <View className="flex-1 bg-background">
                {!isWide && (
                  <MobileHeader
                    onMenuPress={toggleDrawer}
                    title={getPageTitle(pathname)}
                    menuOpen={drawerOpen}
                    isNative={isNativeApp}
                  />
                )}
                <View className="flex-1">
                  <Slot />
                </View>
              </View>
            </Animated.View>
          </Animated.View>
        </View>
      </View>

      {!isWide && !nativeSheetDrawer && drawerOpen && (
        <AdminSidebar {...sidebarProps} isDrawer onClose={resetDrawer} />
      )}
    </SafeAreaView>
  )
}

const overlayStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
    flexDirection: 'row',
    elevation: 10,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  panel: {
    zIndex: 10,
    height: '100%',
  },
})
