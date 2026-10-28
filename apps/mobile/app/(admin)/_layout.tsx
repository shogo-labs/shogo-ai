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
  ADMIN_WEB_WIDE_MIN_WIDTH,
  NATIVE_PHONE_HEADER_ICON_SIZE, nativePhoneCanvas, WEB_PHONE_MAX_WIDTH, useNativePhoneIconChrome } from '../../lib/native-phone-layout'
import { PHONE_DENSITY } from '../../lib/phone-density'
import {
  useNativeSheetDrawer,
  nativeDrawerTopInset,
  nativeDrawerSideInset,
  nativeDrawerFooterInset,
} from '../../lib/use-native-drawer-swipe'
import { NativeSheetDrawerShell } from "../../components/layout/NativeSheetDrawerShell";
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
  ShieldAlert,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { DomainProvider } from '../../contexts/domain'
import { useResolvedTheme } from '../../contexts/theme'
import { API_URL } from '../../lib/api'
import { usePlatformConfig } from '../../lib/platform-config';
import { densityFor } from "../../lib/phone-density"
import { adminPageTitle, isAdminNavActive } from '../../lib/admin-nav'
import { useAdminCheck } from '../../hooks/useAdminCheck'

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
      { href: '/(admin)/admin/analytics', icon: BarChart3, label: 'Marketing Analytics', scopes: ['analytics:read', 'marketing:read'] },
      { href: '/(admin)/creators', icon: Sparkles, label: 'Creators', scopes: ['creators:read', 'creators:write'] },
      { href: '/(admin)/affiliate-content', icon: Clapperboard, label: 'Affiliate CPM', scope: 'creators:write' },
      { href: '/(admin)/affiliate-payouts', icon: Wallet, label: 'Affiliate payouts', scope: 'creators:write' },
      { href: '/(admin)/signup-risk', icon: ShieldAlert, label: 'Signup risk', scope: 'creators:write' },
    ],
  },
  {
    title: 'Marketplace',
    items: [
      { href: '/(admin)/admin/marketplace', icon: Store, label: 'Marketplace' },
    ],
  },
  {
    title: 'Platform',
    items: [
      { href: '/(admin)/users', icon: Users, label: 'Users' },
      { href: '/(admin)/workspaces', icon: Building2, label: 'Workspaces' },
      { href: '/(admin)/admin/projects', icon: FolderKanban, label: 'Projects' },
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
      { href: '/(admin)/admin/settings', icon: BrainCircuit, label: 'AI' },
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
  { href: '/(admin)/admin/projects', icon: FolderKanban, label: 'Projects' },
  { href: '/(admin)/admin/analytics', icon: BarChart3, label: 'Marketing Analytics' },
  { href: '/(admin)/ai-analytics', icon: Activity, label: 'AI Analytics' },
  { href: '/(admin)/heartbeats', icon: Heart, label: 'Heartbeats' },
  { href: '/(admin)/evals', icon: FlaskConical, label: 'Evals' },
] as const

const LOCAL_SETTINGS_ITEMS = [
  { href: '/(admin)/general' as const, icon: Settings, label: 'General' },
  { href: '/(admin)/admin/meetings' as const, icon: Mic, label: 'Meetings' },
  { href: '/(admin)/logs' as const, icon: ScrollText, label: 'Logs' },
  { href: '/(admin)/admin/settings' as const, icon: BrainCircuit, label: 'AI' },
] as const


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
  const isDark = useResolvedTheme() === 'dark'
  const { localMode } = usePlatformConfig()
  const density = densityFor(Boolean(isNativeDrawer));
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
    const active = isAdminNavActive(pathname, item.href)
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
          size={density.icon.nav}
          className={active ? 'text-foreground' : 'text-muted-foreground'}
        />
        <Text className={cn(
            `${density.text.body} flex-1`, active ? 'text-foreground' : 'text-muted-foreground')}>
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
    density.text.label,
  )

  const sidebar = (
    <View
      className={cn('h-full', isNativeDrawer ? 'w-full' : 'w-64 bg-background border-r border-border/70')}
      style={
        isNativeDrawer
          ? {
              backgroundColor: nativePhoneCanvas(isDark),
              paddingLeft: nativeDrawerSideInset(insets.left),
              paddingRight: 4,
            }
          : undefined
      }
    >
      {isNativeDrawer ? <View style={{ height: nativeDrawerTopInset(insets.top) }} /> : null}
      <View className={cn(
        'border-b border-border/70 flex-row items-center justify-between',
        isNativeDrawer ? 'h-16 px-3' : 'px-4 py-4',
      )}>
        <View className={cn('flex-row items-center', isNativeDrawer ? 'gap-3' : 'gap-2')}>
          <View className={cn(
            'items-center justify-center rounded-lg bg-primary/10',
            isNativeDrawer ? 'h-10 w-10' : 'h-8 w-8',
          )}>
            <Shield size={density.icon.nav} className="text-primary" />
          </View>
          <View className="gap-0.5">
            <Text className={cn('font-semibold text-foreground', density.text.title)}>
              Shogo Admin
            </Text>
            <Text className={cn('text-muted-foreground', density.text.label)}>
              {isSuperAdmin ? 'Control room' : 'Workspace controls'}
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
          <ArrowLeft size={density.icon.nav} className="text-muted-foreground" />
          <Text className={cn('text-muted-foreground', density.text.body)}>Back to App</Text>
        </Pressable>

        <View className={cn('flex-row items-center px-2', isNativeDrawer ? 'min-h-14 gap-3 py-2' : 'gap-2 py-1.5')}>
          <View className={cn('rounded bg-primary/20 items-center justify-center', isNativeDrawer ? 'h-11 w-11' : 'h-7 w-7')}>
            <Text className={cn('font-bold text-primary', density.text.body)}>
              {userName?.charAt(0)?.toUpperCase() || 'A'}
            </Text>
          </View>
          <View className="flex-1 min-w-0">
            <Text className={cn('text-foreground', density.text.body)} numberOfLines={1}>
              {userName || 'Admin'}
            </Text>
            <Text className={cn('text-muted-foreground', density.text.label)} numberOfLines={1}>
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
  const icon = useNativePhoneIconChrome()
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
          className={`${PHONE_DENSITY.hit} rounded-full bg-muted`}
        >
          <Menu size={NATIVE_PHONE_HEADER_ICON_SIZE} color={icon.color} strokeWidth={icon.strokeWidth} />
        </Pressable>
        <View className="flex-1 items-center px-3">
          <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Admin console
          </Text>
          <Text className={`${PHONE_DENSITY.text.body} font-semibold text-foreground`} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View className={PHONE_DENSITY.hitSize} />
      </View>
    )
  }

  return (
    <View className="flex-row items-center min-h-14 px-3 border-b border-border/70 bg-background">
      <Pressable onPress={onMenuPress} role="button" accessibilityLabel="Open menu" className="p-2 -ml-1 rounded-md active:bg-muted">
        <Menu size={20} className="text-foreground" />
      </Pressable>
      <View className="flex-row items-center gap-2.5 ml-2">
        <View className="h-7 w-7 items-center justify-center rounded-md bg-primary/10">
          <Shield size={14} className="text-primary" />
        </View>
        <View>
          <Text className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Admin console
          </Text>
          <Text className="text-sm font-semibold text-foreground">{title}</Text>
        </View>
      </View>
    </View>
  )
}

function DesktopContextHeader({ title }: { title: string }) {
  return (
    <View className="min-h-20 flex-row items-center justify-between border-b border-border/70 bg-background px-8">
      <View>
        <Text className="text-[11px] font-semibold uppercase tracking-[1.5px] text-muted-foreground">
          Shogo / Admin console
        </Text>
        <Text className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</Text>
      </View>
      <View className="rounded-full border border-border bg-card px-3 py-1.5">
        <Text className="text-xs font-medium text-muted-foreground">Private workspace</Text>
      </View>
    </View>
  )
}

export default function AdminLayout() {
  return (
    <DomainProvider>
      <AdminLayoutInner />
    </DomainProvider>
  )
}

/**
 * The URL the document was opened at, captured while the bundle evaluates —
 * before the router can rewrite history. `null` on native, where there is no
 * address bar.
 */
const ENTRY_PATHNAME: string | null =
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location?.pathname ?? null
    : null

function AdminLayoutInner() {
  const router = useRouter()
  const pathname = usePathname()
  const { width } = useWindowDimensions()
  const isNativeApp = Platform.OS !== 'web'
  const isDark = useResolvedTheme() === 'dark'
  const nativeDrawerCanvas = nativePhoneCanvas(isDark)
  const isWide = !isNativeApp && width >= ADMIN_WEB_WIDE_MIN_WIDTH
  const nativeSheetDrawer =
    isNativeApp || (Platform.OS === 'web' && width <= WEB_PHONE_MAX_WIDTH)
  const { isSuperAdmin, scopes, hasAdminAccess, gate, localMode, isAuthenticated, userEmail, userName } = useAdminCheck()
  const isPending = gate === 'loading'
  const infraHealth = useInfraHealth(isSuperAdmin)
  const drawer = useNativeSheetDrawer({
    windowWidth: width,
    isDark,
    swipeEnabled: nativeSheetDrawer,
    overlayOpenWithoutSnap: !nativeSheetDrawer,
  })

  const { drawerOpen, closeDrawer, toggleDrawer, resetDrawer } = drawer;

  const sidebarProps = {
    userName,
    userEmail,
    infraHealth,
    isSuperAdmin,
    scopes,
  } as const

  // Portal entry: must be authenticated AND have some admin access. `gate`
  // holds at `loading` while the session resolves — and, locally, while
  // auto-sign-in is still in flight — so a cold admin deep link is never
  // forwarded to `/(app)` before the answer is known (SHO-116).
  useEffect(() => {
    if (gate === 'redirect') {
      router.replace('/(app)')
    }
  }, [gate, router])

  // Per-route guard: a partial admin who deep-links to a page they lack
  // permission for is bounced to their first permitted page (the backend
  // also 403s those endpoints — this is the matching UX).
  useEffect(() => {
    if (isPending || !isAuthenticated || !hasAdminAccess || isSuperAdmin || localMode) return
    const permitted = ALL_NAV_ITEMS.filter((item) =>
      canSeeNavItem(item, isSuperAdmin, scopes),
    )
    const onPermitted = permitted.some((item) => isAdminNavActive(pathname, item.href))
    if (!onPermitted && permitted.length > 0) {
      router.replace(permitted[0].href as any)
    }
  }, [isPending, isAuthenticated, hasAdminAccess, isSuperAdmin, localMode, scopes, pathname, router])

  // Local mode has no console index, so the console root hops to Projects. It
  // must only do that when the console root is where the visitor *arrived*:
  // expo-router publishes its initial navigation state as `/` on a cold load
  // before it applies the URL the document was opened at, so `usePathname()`
  // briefly reads `/` on every deep link. Acting on that frame is what turned a
  // cold `/admin/settings` into `/admin/projects` (SHO-116).
  useEffect(() => {
    if (!localMode || isPending || !hasAdminAccess) return
    const p = pathname
    if (p !== '/' && p !== '' && p !== '/(admin)' && p !== '/index') return
    if (ENTRY_PATHNAME !== null && ENTRY_PATHNAME !== '/' && ENTRY_PATHNAME !== '') return
    router.replace('/(admin)/admin/projects' as any)
  }, [localMode, isPending, hasAdminAccess, pathname, router])

  useEffect(() => {
    if (isWide) resetDrawer()
  }, [isWide, resetDrawer])

  if (gate === 'loading') {
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

  if (gate !== 'render') return null

  return (
    <NativeSheetDrawerShell
      isWide={isWide}
      nativeSheetDrawer={nativeSheetDrawer}
      canvas={nativeDrawerCanvas}
      safeAreaEdges={nativeSheetDrawer ? ['left', 'right'] : undefined}
      sidebarWide={<AdminSidebar {...sidebarProps} />}
      sidebarSheet={
        <AdminSidebar
          {...sidebarProps}
          isNativeDrawer
          onClose={closeDrawer}
        />
      }
      sidebarOverlay={
        drawerOpen ? (
          <AdminSidebar {...sidebarProps} isDrawer onClose={closeDrawer} />
        ) : null
      }
      header={
        isWide ? (
          <DesktopContextHeader title={adminPageTitle(pathname)} />
        ) : (
          <MobileHeader
            onMenuPress={toggleDrawer}
            title={adminPageTitle(pathname)}
            menuOpen={drawerOpen}
            isNative={nativeSheetDrawer}
          />
        )
      }
      drawer={drawer}
    >
      <Slot />
    </NativeSheetDrawerShell>
  )
}

const overlayStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    zIndex: 50,
    flexDirection: 'row',
    elevation: 10,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  panel: {
    zIndex: 10,
    height: '100%',
  },
})
