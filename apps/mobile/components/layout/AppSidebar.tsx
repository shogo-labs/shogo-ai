/**
 * AppSidebar - Responsive navigation sidebar matching staging design
 *
 * Wide screens (>= 768px): persistent sidebar pinned to the left (w-64, collapsible to w-16)
 * Narrow screens (< 768px): slide-over drawer with backdrop overlay
 *
 * Sections:
 *  - Logo row: gradient "S" badge + "Shogo" text + collapse toggle
 *  - Workspace switcher
 *  - Primary nav: Home + Search (Cmd+K)
 *  - PROJECTS section: Recent (5 projects), All Projects (with New Folder), Starred, Shared
 *  - RESOURCES section: Templates, Docs (external)
 *  - Upgrade to Pro CTA
 *  - User avatar + Sign Out
 */

import { useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Linking,
  TextInput,
  Modal,
  useWindowDimensions,
  Platform,
} from 'react-native'
import { useTheme } from '../../contexts/theme'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import {
  Home,
  Search,
  Clock,
  LayoutGrid,
  Star,
  Users,
  User,
  FileCode2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeft,
  FolderPlus,
  Plus,
  X,
  LogOut,
  Sun,
  Moon,
  Monitor,
  Settings,
  Zap,
  Check,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Avatar } from '@shogo/shared-ui/primitives'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { useAuth } from '../../contexts/auth'
import {
  useProjectCollection,
  useWorkspaceCollection,
  useFolderCollection,
  useDomainActions,
  useDomainHttp,
} from '../../contexts/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import { formatCredits } from '../../lib/billing-config'
import { api } from '../../lib/api'
import { getActiveWorkspaceId, setActiveWorkspaceId } from '../../lib/workspace-store'

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function isRouteActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  }
  const normalizedPathname = pathname.replace('/(app)', '')
  const normalizedHref = href.replace('/(app)', '')
  if (normalizedHref === '/projects') {
    return normalizedPathname === '/projects' || normalizedPathname.startsWith('/projects/')
  }
  return normalizedPathname === normalizedHref || normalizedPathname.startsWith(normalizedHref + '/')
}

// ─── NavItem ───────────────────────────────────────────────

interface NavItemProps {
  icon: React.ElementType
  label: string
  href?: string
  externalHref?: string
  active?: boolean
  collapsed?: boolean
  onPress?: () => void
  shortcut?: string
  external?: boolean
  onNavPress?: () => void
}

function NavItem({
  icon: Icon,
  label,
  href,
  externalHref,
  active,
  collapsed,
  onPress,
  shortcut,
  onNavPress,
}: NavItemProps) {
  const router = useRouter()

  const handlePress = useCallback(() => {
    if (onPress) {
      onPress()
      return
    }
    if (externalHref) {
      Linking.openURL(externalHref)
      return
    }
    if (href) {
      router.push(href as any)
      onNavPress?.()
    }
  }, [href, externalHref, onPress, router, onNavPress])

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        'flex-row items-center gap-3 rounded-md px-3 py-2',
        active
          ? 'bg-accent'
          : 'active:bg-accent/50',
        collapsed && 'justify-center px-2'
      )}
    >
      <Icon
        size={16}
        className={cn(
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
      {!collapsed && (
        <Text
          className={cn(
            'text-sm flex-1',
            active ? 'text-foreground' : 'text-muted-foreground'
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
      {!collapsed && shortcut && Platform.OS === 'web' && (
        <View className="ml-auto rounded border border-border bg-muted px-1.5 py-0.5">
          <Text className="text-[10px] font-mono text-muted-foreground">{shortcut}</Text>
        </View>
      )}
      {!collapsed && externalHref && (
        <ExternalLink size={12} className="ml-auto text-muted-foreground opacity-50" />
      )}
    </Pressable>
  )
}

// ─── NavSection (collapsible) ──────────────────────────────

interface NavSectionProps {
  title: string
  collapsed?: boolean
  children: React.ReactNode
  defaultExpanded?: boolean
}

function NavSection({ title, collapsed, children, defaultExpanded = true }: NavSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  if (collapsed) return <>{children}</>

  return (
    <View className="mt-4">
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center gap-1 px-3 py-1"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground" />
        )}
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </Text>
      </Pressable>
      {expanded && children}
    </View>
  )
}

// ─── ExpandableNavItem ─────────────────────────────────────

interface ExpandableNavItemProps {
  icon: React.ElementType
  label: string
  href?: string
  active?: boolean
  collapsed?: boolean
  defaultExpanded?: boolean
  children?: React.ReactNode
  onNavPress?: () => void
}

function ExpandableNavItem({
  icon: Icon,
  label,
  href,
  active,
  collapsed,
  defaultExpanded = true,
  children,
  onNavPress,
}: ExpandableNavItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const router = useRouter()

  const handlePress = useCallback(() => {
    if (href) {
      router.push(href as any)
      onNavPress?.()
    }
  }, [href, router, onNavPress])

  if (collapsed) {
    return (
      <Pressable
        onPress={handlePress}
        className={cn(
          'items-center justify-center rounded-md px-2 py-2',
          active ? 'bg-accent' : 'active:bg-accent/50'
        )}
      >
        <Icon size={16} className={active ? 'text-foreground' : 'text-muted-foreground'} />
      </Pressable>
    )
  }

  return (
    <View>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className={cn(
          'flex-row items-center gap-3 rounded-md px-3 py-2',
          active ? 'bg-accent' : 'active:bg-accent/50'
        )}
      >
        <Icon
          size={16}
          className={active ? 'text-foreground' : 'text-muted-foreground'}
        />
        <Pressable onPress={handlePress} className="flex-1">
          <Text
            className={cn('text-sm', active ? 'text-foreground' : 'text-muted-foreground')}
            numberOfLines={1}
          >
            {label}
          </Text>
        </Pressable>
        {expanded ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </Pressable>
      {expanded && (
        <View className="ml-6 mt-0.5">
          {children}
        </View>
      )}
    </View>
  )
}

// ─── ProjectItem ───────────────────────────────────────────

function ProjectItem({
  name,
  projectId,
  onNavPress,
}: {
  name: string
  projectId: string
  onNavPress?: () => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const isActive = pathname.includes(projectId)

  return (
    <Pressable
      onPress={() => {
        router.push(`/(app)/projects/${projectId}` as any)
        onNavPress?.()
      }}
      className={cn(
        'flex-row items-center rounded-md px-2 py-1.5',
        isActive ? 'bg-accent' : 'active:bg-accent/50'
      )}
    >
      <Text
        className={cn(
          'text-sm',
          isActive ? 'text-foreground' : 'text-muted-foreground'
        )}
        numberOfLines={1}
      >
        {name}
      </Text>
    </Pressable>
  )
}

// ─── UserMenu (popover anchored to avatar) ─────────────────

interface UserMenuProps {
  user: { name?: string | null; email?: string | null; image?: string | null } | null
  onSignOut: () => void
  onNavigate: (href: string) => void
}

function UserMenu({ user, onSignOut, onNavigate }: UserMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  return (
    <Popover
      placement="top"
      size="xs"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable {...triggerProps} className="rounded-full active:opacity-80">
          <Avatar
            fallback={getInitials(user?.name)}
            src={user?.image}
            size="sm"
          />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="max-w-[224px] p-0">
        <PopoverBody>
          {/* User info header */}
          <View className="px-3 py-2.5 border-b border-border">
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {user?.name || 'User'}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {user?.email || ''}
            </Text>
          </View>

          {/* Menu items */}
          <View className="py-1">
            <Pressable
              onPress={() => { onNavigate('/(app)/profile'); setIsOpen(false) }}
              className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
            >
              <User size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground">Profile</Text>
            </Pressable>

            <Pressable
              onPress={() => setAppearanceOpen(!appearanceOpen)}
              className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
            >
              <Monitor size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground flex-1">Appearance</Text>
              <ChevronRight size={14} className="text-muted-foreground" />
            </Pressable>

            {appearanceOpen && (
              <View className="pl-9 pr-3 py-1">
                {([
                  { value: 'light' as const, label: 'Light', Icon: Sun },
                  { value: 'dark' as const, label: 'Dark', Icon: Moon },
                  { value: 'system' as const, label: 'System', Icon: Monitor },
                ] as const).map(({ value, label, Icon }) => (
                  <Pressable
                    key={value}
                    onPress={() => setTheme(value)}
                    className="flex-row items-center gap-2 py-1.5 active:bg-muted rounded-md px-1"
                  >
                    <Icon size={14} className={theme === value ? 'text-primary' : 'text-muted-foreground'} />
                    <Text className={cn('text-sm flex-1', theme === value ? 'text-primary' : 'text-foreground')}>
                      {label}
                    </Text>
                    {theme === value && <Check size={14} className="text-primary" />}
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          <View className="h-px bg-border" />

          <View className="py-1">
            <Pressable
              onPress={() => { onSignOut(); setIsOpen(false) }}
              className="flex-row items-center gap-2 px-3 py-2 active:bg-muted"
            >
              <LogOut size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground">Sign Out</Text>
            </Pressable>
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

// ─── WorkspaceSwitcher (popover anchored to workspace button) ─

interface WorkspaceSwitcherProps {
  collapsed: boolean
  workspaces: any[]
  currentWorkspace: any
  billingData: any
  workspacePlan: { planId: string; status: string | null } | null
  allPlans: Record<string, { planId: string; status: string | null }>
  onNavigate: (href: string) => void
  onSwitchWorkspace: (workspaceId: string) => void
  onCreateWorkspace: () => void
}

function WorkspaceSwitcher({
  collapsed,
  workspaces,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  onNavigate,
  onSwitchWorkspace,
  onCreateWorkspace,
}: WorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false)

  const wsInitial = currentWorkspace?.name?.[0]?.toUpperCase() ?? 'W'
  const resolvedPlanId = workspacePlan?.planId ?? billingData.subscription?.planId ?? 'free'
  const planType = resolvedPlanId !== 'free'
    ? resolvedPlanId.charAt(0).toUpperCase() + resolvedPlanId.slice(1)
    : 'Free'
  const effectiveBalance = billingData.effectiveBalance
  const creditsTotal = effectiveBalance
    ? Math.max(effectiveBalance.total, 1)
    : 55
  const creditsRemaining = effectiveBalance?.total ?? 0

  return (
    <Popover
      placement="bottom"
      size="sm"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          className={cn(
            'flex-row items-center gap-2 rounded-md px-2 py-1.5 active:bg-muted',
            collapsed && 'justify-center px-0'
          )}
        >
          <View className="h-6 w-6 rounded bg-primary/20 items-center justify-center">
            <Text className="text-[10px] font-bold text-primary">
              {currentWorkspace?.name?.[0]?.toUpperCase() || 'W'}
            </Text>
          </View>
          {!collapsed && (
            <>
              <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                {currentWorkspace?.name || 'Workspace'}
              </Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </>
          )}
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="max-w-[280px] p-0">
        <View className="flex-col overflow-hidden max-h-[480px]">
          {/* ── Pinned top: workspace header + actions ── */}
          {currentWorkspace && (
            <View className="px-4 py-3">
              <View className="flex-row items-start gap-3">
                <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
                  <Text className="text-sm font-medium text-primary">{wsInitial}</Text>
                </View>
                <View className="flex-1 min-w-0">
                  <Text className="font-medium text-foreground" numberOfLines={1}>
                    {currentWorkspace.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {planType} Plan {'\u00B7'} 1 member
                  </Text>
                </View>
              </View>
            </View>
          )}

          {currentWorkspace && (
            <View className="px-3 pb-2 flex-row gap-2">
              <Pressable
                onPress={() => { onNavigate('/(app)/settings'); setIsOpen(false) }}
                className="flex-1 flex-row items-center justify-center gap-1.5 h-8 rounded-md border border-border active:bg-muted"
              >
                <Settings size={14} className="text-muted-foreground" />
                <Text className="text-xs text-foreground">Settings</Text>
              </Pressable>
              <Pressable
                onPress={() => { onNavigate('/(app)/members'); setIsOpen(false) }}
                className="flex-1 flex-row items-center justify-center gap-1.5 h-8 rounded-md border border-border active:bg-muted"
              >
                <Users size={14} className="text-muted-foreground" />
                <Text className="text-xs text-foreground">Invite</Text>
              </Pressable>
            </View>
          )}

          <View className="h-px bg-border" />

          {/* ── Scrollable middle ── */}
          <ScrollView
            className="shrink"
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
          >
            {/* Credits */}
            {currentWorkspace && (
              <>
                <View className="px-4 py-3 gap-2">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm text-muted-foreground">Credits</Text>
                    <Text className="text-sm font-medium text-foreground">
                      {formatCredits(creditsRemaining)} left
                    </Text>
                  </View>
                  <View className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <View
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, (creditsRemaining / creditsTotal) * 100)}%` }}
                    />
                  </View>
                  {effectiveBalance && (
                    <Text className="text-xs text-muted-foreground">
                      Daily: {formatCredits(effectiveBalance.dailyCredits)} {'\u00B7'} Monthly: {formatCredits(effectiveBalance.monthlyCredits)}
                    </Text>
                  )}
                </View>

                <View className="h-px bg-border" />
              </>
            )}

            {/* Upgrade CTA */}
            {currentWorkspace && planType === 'Free' && (
              <>
                <View className="px-3 py-2">
                  <Pressable
                    onPress={() => { onNavigate('/(app)/billing'); setIsOpen(false) }}
                    className="flex-row items-center justify-center gap-2 h-9 rounded-md"
                    style={Platform.OS === 'web'
                      ? { backgroundImage: 'linear-gradient(to right, #3b82f6, #9333ea)' } as any
                      : { backgroundColor: '#7c3aed' }}
                  >
                    <Zap size={16} className="text-white" />
                    <Text className="text-sm font-medium text-white">Upgrade to Pro</Text>
                  </Pressable>
                </View>

                <View className="h-px bg-border" />
              </>
            )}

            {/* All workspaces */}
            <View className="py-1">
              <Text className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                All workspaces
              </Text>
              {workspaces.map((ws: any) => {
                const isCurrent = ws.id === currentWorkspace?.id
                return (
                  <Pressable
                    key={ws.id}
                    onPress={() => {
                      if (!isCurrent) {
                        onSwitchWorkspace(ws.id)
                      }
                      setIsOpen(false)
                    }}
                    className="flex-row items-center gap-2 px-4 py-2 active:bg-muted"
                  >
                    <View className="h-6 w-6 rounded bg-primary/10 items-center justify-center">
                      <Text className="text-[10px] font-medium text-primary">
                        {ws.name?.[0]?.toUpperCase() ?? 'W'}
                      </Text>
                    </View>
                    <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                      {ws.name}
                    </Text>
                    {(() => {
                      const wsPlanId = allPlans[ws.id]?.planId ?? 'free'
                      const isPaid = wsPlanId !== 'free'
                      const label = isPaid
                        ? wsPlanId.charAt(0).toUpperCase() + wsPlanId.slice(1)
                        : 'Free'
                      return (
                        <View className={cn('rounded px-1.5 py-0.5', isPaid ? 'bg-primary/10' : 'bg-muted')}>
                          <Text className={cn('text-[10px]', isPaid ? 'text-primary font-medium' : 'text-muted-foreground')}>{label}</Text>
                        </View>
                      )
                    })()}
                    {isCurrent && (
                      <Check size={16} className="text-primary" />
                    )}
                  </Pressable>
                )
              })}
            </View>
          </ScrollView>

          <View className="h-px bg-border" />

          {/* ── Pinned bottom: create workspace ── */}
          <View className="p-1">
            <Pressable
              onPress={() => {
                setIsOpen(false)
                onCreateWorkspace()
              }}
              className="flex-row items-center gap-2 px-4 py-2 rounded-md active:bg-muted"
            >
              <Plus size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground">Create new workspace</Text>
            </Pressable>
          </View>
        </View>
      </PopoverContent>
    </Popover>
  )
}

// ─── CreateFolderModal ─────────────────────────────────────

function CreateFolderModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState('')

  const handleSubmit = useCallback(() => {
    if (name.trim()) {
      onSubmit(name.trim())
      setName('')
      onClose()
    }
  }, [name, onSubmit, onClose])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50 items-center justify-center" onPress={onClose}>
        <Pressable
          className="bg-card rounded-xl p-6 w-80 border border-border"
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-semibold text-foreground">Create new folder</Text>
            <Pressable onPress={onClose} className="p-1">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">
            Create a new folder to organize your projects
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Enter folder name"
            placeholderTextColor="#9ca3af"
            className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background mb-4"
            autoFocus
            onSubmitEditing={handleSubmit}
          />
          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              className="px-4 py-2 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              className={cn(
                'px-4 py-2 rounded-md',
                name.trim() ? 'bg-primary active:bg-primary/80' : 'bg-muted'
              )}
              disabled={!name.trim()}
            >
              <Text className={cn('text-sm', name.trim() ? 'text-primary-foreground' : 'text-muted-foreground')}>
                Create folder
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ─── CreateWorkspaceModal (free — first workspace only) ────

function CreateWorkspaceModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState('')

  const handleSubmit = useCallback(() => {
    if (name.trim()) {
      onSubmit(name.trim())
      setName('')
      onClose()
    }
  }, [name, onSubmit, onClose])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50 items-center justify-center" onPress={onClose}>
        <Pressable
          className="bg-card rounded-xl p-6 w-80 border border-border"
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-semibold text-foreground">Create new workspace</Text>
            <Pressable onPress={onClose} className="p-1">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">
            Create a new workspace for your team or projects
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Enter workspace name"
            placeholderTextColor="#9ca3af"
            className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background mb-4"
            autoFocus
            onSubmitEditing={handleSubmit}
          />
          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              className="px-4 py-2 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              className={cn(
                'px-4 py-2 rounded-md',
                name.trim() ? 'bg-primary active:bg-primary/80' : 'bg-muted'
              )}
              disabled={!name.trim()}
            >
              <Text className={cn('text-sm', name.trim() ? 'text-primary-foreground' : 'text-muted-foreground')}>
                Create workspace
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ─── Main AppSidebar ───────────────────────────────────────

interface AppSidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export const AppSidebar = observer(function AppSidebar({ isOpen, onClose }: AppSidebarProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const isWide = width >= 768

  const { user, signOut } = useAuth()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const actions = useDomainActions()
  const http = useDomainHttp()

  useEffect(() => {
    workspaces.loadAll().catch(() => {})
    projects.loadAll().catch(() => {})
  }, [])

  // Detect return from Stripe checkout: verify payment, provision subscription, reload
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const checkout = params.get('checkout')
    const wsId = params.get('workspace')
    const sessionId = params.get('session_id')
    if (checkout === 'workspace_created' && wsId && sessionId) {
      const provision = async () => {
        try { await api.verifyCheckout(http, sessionId) } catch { /* webhook will handle it */ }
        // Full reload ensures auth + billing data initialize cleanly
        window.location.href = `/?workspace=${wsId}`
      }
      provision()
    } else if (params.get('workspace') && !params.get('checkout')) {
      // After reload: pick up the workspace param, switch to it, clean URL
      const targetWs = params.get('workspace')!
      workspaces.loadAll().then(() => {
        setSelectedWorkspaceId(targetWs)
        setActiveWorkspaceId(targetWs)
        projects.loadAll({ workspaceId: targetWs }).catch(() => {})
      })
      window.history.replaceState({}, '', '/')
    }
  }, [])

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    () => getActiveWorkspaceId()
  )

  let currentWorkspace: any
  try {
    if (selectedWorkspaceId) {
      currentWorkspace = workspaces?.all?.find((w: any) => w.id === selectedWorkspaceId) ?? workspaces?.all?.[0]
    } else {
      currentWorkspace = workspaces?.all?.[0]
    }
  } catch {
    currentWorkspace = undefined
  }

  const billingData = useBillingData(currentWorkspace?.id)

  const [allPlans, setAllPlans] = useState<Record<string, { planId: string; status: string | null }>>({})

  let recentProjects: any[]
  try {
    const all = projects?.all ?? []
    recentProjects = [...all]
      .sort((a: any, b: any) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
        return bTime - aTime
      })
      .slice(0, 5)
  } catch {
    recentProjects = []
  }

  const [collapsed, setCollapsed] = useState(false)
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } = useCommandPalette()

  let allWorkspaces: any[]
  try { allWorkspaces = workspaces?.all?.slice() ?? [] } catch { allWorkspaces = [] }

  // Fetch plans for all workspaces in a single call
  useEffect(() => {
    if (!allWorkspaces.length) return
    let cancelled = false
    const ids = allWorkspaces.map((w: any) => w.id)
    api.getWorkspacePlans(http, ids)
      .then((plans) => { if (!cancelled) setAllPlans(plans) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [allWorkspaces.length, http])

  const workspacePlan = currentWorkspace?.id ? (allPlans[currentWorkspace.id] ?? null) : null
  const isPaidPlan = billingData.hasActiveSubscription || (workspacePlan?.planId !== 'free' && workspacePlan?.status === 'active')

  const toggleCollapse = useCallback(() => setCollapsed((c) => !c), [])

  const handleCreateFolder = useCallback(
    async (name: string) => {
      if (currentWorkspace?.id) {
        try {
          await actions.createFolder(name, currentWorkspace.id, null)
        } catch (e) {
          console.warn('Failed to create folder:', e)
        }
      }
    },
    [actions, currentWorkspace]
  )

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      setSelectedWorkspaceId(workspaceId)
      setActiveWorkspaceId(workspaceId)
      projects.loadAll({ workspaceId }).catch(() => {})
    },
    [projects]
  )

  const handleCreateWorkspace = useCallback(
    () => {
      if (allWorkspaces.length >= 1) {
        router.push('/(app)/new-workspace' as any)
      } else {
        setCreateWorkspaceOpen(true)
      }
    },
    [allWorkspaces.length, router]
  )

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (!user?.id) return
      try {
        const newWorkspace = await actions.createWorkspace(name, undefined, user.id)
        if (newWorkspace?.id) {
          setSelectedWorkspaceId(newWorkspace.id)
          await workspaces.loadAll()
          await projects.loadAll({ workspaceId: newWorkspace.id })
        }
      } catch (e) {
        console.warn('Failed to create workspace:', e)
      }
    },
    [actions, user?.id, workspaces, projects]
  )

  const handleSignOut = useCallback(async () => {
    try {
      await signOut()
    } catch {}
  }, [signOut])

  const onNavPress = useCallback(() => {
    if (!isWide) onClose?.()
  }, [isWide, onClose])

  const handleSearchPress = useCallback(() => {
    setCommandPaletteOpen(true)
  }, [setCommandPaletteOpen])

  const isHomePage = pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  const isProjectsPage = pathname.startsWith('/projects') || pathname.startsWith('/(app)/projects')

  const sidebarContent = (
    <View className={cn('flex-1 bg-card border-r border-border', collapsed ? 'w-16' : 'w-64')}>
      {/* ── Logo Row ── */}
      <View
        className={cn(
          'h-14 border-b border-border flex-row items-center',
          collapsed ? 'justify-center px-2' : 'justify-between px-4'
        )}
      >
        {!collapsed && (
          <>
            <Pressable
              onPress={() => { router.push('/(app)' as any); onNavPress() }}
              className="flex-row items-center gap-2"
            >
              <View className="h-8 w-8 rounded-lg bg-blue-500 items-center justify-center"
                style={Platform.OS === 'web'
                  ? { backgroundImage: 'linear-gradient(to bottom right, #3b82f6, #9333ea)' } as any
                  : undefined}
              >
                <Text className="text-white font-bold text-sm">S</Text>
              </View>
              <Text className="font-semibold text-foreground">Shogo</Text>
            </Pressable>
            <Pressable onPress={toggleCollapse} className="h-8 w-8 items-center justify-center rounded-md active:bg-muted">
              <PanelLeftClose size={16} className="text-muted-foreground" />
            </Pressable>
          </>
        )}
        {collapsed && (
          <Pressable
            onPress={toggleCollapse}
            className="h-8 w-8 rounded-lg bg-blue-500 items-center justify-center"
            style={Platform.OS === 'web'
              ? { backgroundImage: 'linear-gradient(to bottom right, #3b82f6, #9333ea)' } as any
              : undefined}
          >
            <Text className="text-white font-bold text-sm">S</Text>
          </Pressable>
        )}
      </View>

      {/* ── Workspace Switcher ── */}
      <View className={cn('p-2 border-b border-border', collapsed && 'px-1')}>
        <WorkspaceSwitcher
          collapsed={collapsed}
          workspaces={allWorkspaces}
          currentWorkspace={currentWorkspace}
          billingData={billingData}
          workspacePlan={workspacePlan}
          allPlans={allPlans}
          onNavigate={(href) => { router.push(href as any); onNavPress() }}
          onSwitchWorkspace={handleSwitchWorkspace}
          onCreateWorkspace={handleCreateWorkspace}
        />
      </View>

      {/* ── Main Navigation (scrollable) ── */}
      <ScrollView className="flex-1 py-2" showsVerticalScrollIndicator={false}>
        {/* Primary nav */}
        <View className="px-2">
          <NavItem
            icon={Home}
            label="Home"
            href="/(app)"
            active={isHomePage}
            collapsed={collapsed}
            onNavPress={onNavPress}
          />
          <NavItem
            icon={Search}
            label="Search"
            collapsed={collapsed}
            shortcut="⌘K"
            onPress={handleSearchPress}
          />
        </View>

        {/* PROJECTS section */}
        <NavSection title="Projects" collapsed={collapsed}>
          <View className="px-2">
            <ExpandableNavItem
              icon={Clock}
              label="Recent"
              collapsed={collapsed}
              defaultExpanded={true}
            >
              {recentProjects.map((project: any) => (
                <ProjectItem
                  key={project.id}
                  name={project.name}
                  projectId={project.id}
                  onNavPress={onNavPress}
                />
              ))}
            </ExpandableNavItem>

            <ExpandableNavItem
              icon={LayoutGrid}
              label="All projects"
              href="/(app)/projects"
              active={isProjectsPage && !isHomePage}
              collapsed={collapsed}
              defaultExpanded={true}
              onNavPress={onNavPress}
            >
              {!collapsed && (
                <Pressable
                  onPress={() => setCreateFolderOpen(true)}
                  className="flex-row items-center gap-2 px-2 py-1.5 rounded-md active:bg-accent/50"
                >
                  <FolderPlus size={14} className="text-muted-foreground" />
                  <Text className="text-sm text-muted-foreground">New folder</Text>
                </Pressable>
              )}
            </ExpandableNavItem>

            <NavItem
              icon={Star}
              label="Starred"
              href="/(app)/starred"
              active={isRouteActive(pathname, '/(app)/starred')}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
            <NavItem
              icon={Users}
              label="Shared with me"
              href="/(app)/shared"
              active={isRouteActive(pathname, '/(app)/shared')}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
          </View>
        </NavSection>

        {/* RESOURCES section */}
        <NavSection title="Resources" collapsed={collapsed}>
          <View className="px-2">
            <NavItem
              icon={FileCode2}
              label="Templates"
              href="/(app)/templates"
              active={isRouteActive(pathname, '/(app)/templates')}
              collapsed={collapsed}
              onNavPress={onNavPress}
            />
            <NavItem
              icon={ExternalLink}
              label="Docs"
              externalHref="https://docs-staging.shogo.ai/"
              collapsed={collapsed}
            />
          </View>
        </NavSection>
      </ScrollView>

      {/* ── Bottom Section ── */}
      <View className="border-t border-border" style={{ paddingBottom: insets.bottom }}>
        {/* Upgrade to Pro CTA */}
        {!collapsed && !isPaidPlan && (
          <View className="px-2 pt-2">
            <Pressable
              onPress={() => { router.push('/(app)/billing' as any); onNavPress() }}
              className="flex-row items-center gap-2 px-3 py-2 rounded-md"
              style={Platform.OS === 'web'
                ? { backgroundImage: 'linear-gradient(to right, rgba(59,130,246,0.1), rgba(168,85,247,0.1))' } as any
                : { backgroundColor: 'rgba(59,130,246,0.1)' }}
            >
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">Upgrade to Pro</Text>
                <Text className="text-xs text-muted-foreground">
                  {billingData.effectiveBalance
                    ? `${formatCredits(billingData.effectiveBalance.total)} credits left`
                    : 'Unlock more benefits'}
                </Text>
              </View>
              <Plus size={16} className="text-primary" />
            </Pressable>
          </View>
        )}

        {/* User row */}
        <View
          className={cn(
            'flex-row items-center gap-2 p-2 border-t border-border',
            collapsed ? 'justify-center' : 'px-3'
          )}
        >
          <UserMenu
            user={user}
            onSignOut={handleSignOut}
            onNavigate={(href) => router.push(href as any)}
          />

          {!collapsed && (
            <View className="flex-1 ml-1">
              <Text className="text-sm text-foreground" numberOfLines={1}>{user?.name || 'User'}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Modals (true dialogs that are fine as centered overlays) */}
      <CreateFolderModal
        visible={createFolderOpen}
        onClose={() => setCreateFolderOpen(false)}
        onSubmit={handleCreateFolder}
      />
      <CreateWorkspaceModal
        visible={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onSubmit={handleCreateWorkspaceSubmit}
      />
      <CommandPalette
        visible={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />

    </View>
  )

  if (isWide) {
    return (
      <View className="h-full">
        {sidebarContent}
      </View>
    )
  }

  if (!isOpen) return null

  return (
    <View className="absolute inset-0 z-50 flex-row">
      <Pressable onPress={onClose} className="absolute inset-0 bg-black/50" />
      <View className="w-72 h-full z-10">
        {sidebarContent}
      </View>
    </View>
  )
})
