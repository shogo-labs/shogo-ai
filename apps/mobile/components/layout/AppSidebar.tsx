/**
 * AppSidebar - Responsive navigation sidebar mirroring staging web design
 *
 * Structure:
 * - Logo header with gradient badge
 * - Workspace switcher dropdown
 * - Primary nav (Home, Search)
 * - Collapsible PROJECTS section (Recent, All projects, Starred, Shared)
 * - Collapsible RESOURCES section (Templates, Docs)
 * - User avatar with menu at bottom
 *
 * Wide screens (>= 768px): persistent sidebar pinned to the left
 * Narrow screens (< 768px): slide-over drawer with backdrop overlay
 */

import { useState, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Linking,
  useWindowDimensions,
} from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  Home,
  Search,
  Clock,
  LayoutGrid,
  Star,
  Users,
  FileCode2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  User,
  LogOut,
  X,
  Check,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Avatar, AvatarFallbackText, AvatarImage } from '@/components/ui/avatar'
import { Menu, MenuItem, MenuItemLabel, MenuSeparator } from '@/components/ui/menu'
import { useAuth } from '../../contexts/auth'
import { useProjectCollection, useWorkspaceCollection } from '../../contexts/domain'

function getInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// ---------------------------------------------------------------------------
// NavItem
// ---------------------------------------------------------------------------

interface NavItemProps {
  icon: React.ElementType
  label: string
  active?: boolean
  onPress?: () => void
  external?: boolean
}

function NavItem({ icon: Icon, label, active, onPress, external }: NavItemProps) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 px-3 py-2 rounded-md mx-2',
        active
          ? 'bg-accent'
          : 'active:bg-accent/50'
      )}
    >
      <Icon
        size={16}
        className={cn(
          active ? 'text-accent-foreground' : 'text-muted-foreground'
        )}
      />
      <Text
        className={cn(
          'text-sm flex-1',
          active ? 'text-accent-foreground' : 'text-muted-foreground'
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
      {external && (
        <ExternalLink size={12} className="text-muted-foreground opacity-50" />
      )}
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// NavSection - collapsible section with uppercase title
// ---------------------------------------------------------------------------

interface NavSectionProps {
  title: string
  children: React.ReactNode
  defaultExpanded?: boolean
}

function NavSection({ title, children, defaultExpanded = true }: NavSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <View className="py-2">
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center gap-1 px-3 py-1 mx-2"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-muted-foreground/70" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground/70" />
        )}
        <Text className="text-xs font-medium text-muted-foreground/70 uppercase tracking-widest">
          {title}
        </Text>
      </Pressable>
      {expanded && <View className="mt-1">{children}</View>}
    </View>
  )
}

// ---------------------------------------------------------------------------
// ExpandableNavItem - nav item with chevron toggle and expandable children
// ---------------------------------------------------------------------------

interface ExpandableNavItemProps {
  icon: React.ElementType
  label: string
  active?: boolean
  onPress?: () => void
  defaultExpanded?: boolean
  children?: React.ReactNode
}

function ExpandableNavItem({
  icon: Icon,
  label,
  active,
  onPress,
  defaultExpanded = false,
  children,
}: ExpandableNavItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <View>
      <View
        className={cn(
          'flex-row items-center px-3 py-2 rounded-md mx-2',
          active ? 'bg-accent' : ''
        )}
      >
        <Pressable
          onPress={() => setExpanded(!expanded)}
          className="flex-row items-center mr-1"
          hitSlop={8}
        >
          {expanded ? (
            <ChevronDown size={12} className="text-muted-foreground mr-1" />
          ) : (
            <ChevronRight size={12} className="text-muted-foreground mr-1" />
          )}
          <Icon
            size={16}
            className={cn(
              active ? 'text-accent-foreground' : 'text-muted-foreground'
            )}
          />
        </Pressable>
        <Pressable onPress={onPress} className="flex-1 ml-2">
          <Text
            className={cn(
              'text-sm',
              active ? 'text-accent-foreground' : 'text-muted-foreground'
            )}
            numberOfLines={1}
          >
            {label}
          </Text>
        </Pressable>
      </View>
      {expanded && children && (
        <View className="ml-9 pl-2 mt-1 gap-0.5 border-l border-border/50">
          {children}
        </View>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// ProjectItem - compact project link for Recent sub-list
// ---------------------------------------------------------------------------

interface ProjectItemProps {
  name: string
  projectId: string
  onPress: () => void
}

function ProjectItem({ name, onPress }: ProjectItemProps) {
  return (
    <Pressable
      onPress={onPress}
      className="py-1 px-1 rounded-md active:bg-accent/50"
    >
      <Text className="text-sm text-muted-foreground" numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// WorkspaceSwitcher
// ---------------------------------------------------------------------------

interface WorkspaceSwitcherProps {
  onClose?: () => void
}

const WorkspaceSwitcher = observer(function WorkspaceSwitcher({ onClose }: WorkspaceSwitcherProps) {
  const workspaces = useWorkspaceCollection()
  const [isOpen, setIsOpen] = useState(false)

  const allWorkspaces = workspaces.all.slice()
  const currentWorkspace = allWorkspaces[0]

  const handleSelect = useCallback((_ws: any) => {
    setIsOpen(false)
  }, [])

  return (
    <View className="p-2 border-b border-border">
      <Menu
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onOpen={() => setIsOpen(true)}
        placement="bottom left"
        trigger={(triggerProps) => (
          <Pressable
            {...triggerProps}
            className="flex-row items-center gap-2 px-2 py-2 rounded-md active:bg-accent/50"
          >
            <View className="h-6 w-6 rounded-md bg-primary-600 items-center justify-center">
              <Text className="text-white text-xs font-semibold">
                {currentWorkspace?.name?.[0]?.toUpperCase() ?? 'W'}
              </Text>
            </View>
            <Text className="text-sm font-medium text-foreground flex-1" numberOfLines={1}>
              {currentWorkspace?.name ?? 'Workspace'}
            </Text>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>
        )}
      >
        {allWorkspaces.map((ws: any) => (
          <MenuItem
            key={ws.id}
            onPress={() => handleSelect(ws)}
            className="flex-row items-center gap-2"
          >
            <View className="h-5 w-5 rounded bg-primary-600 items-center justify-center">
              <Text className="text-white text-[10px] font-semibold">
                {ws.name?.[0]?.toUpperCase() ?? 'W'}
              </Text>
            </View>
            <MenuItemLabel className="flex-1">{ws.name}</MenuItemLabel>
            {ws.id === currentWorkspace?.id && (
              <Check size={14} className="text-primary" />
            )}
          </MenuItem>
        ))}
      </Menu>
    </View>
  )
})

// ---------------------------------------------------------------------------
// UserAvatarMenu
// ---------------------------------------------------------------------------

interface UserAvatarMenuProps {
  onClose?: () => void
}

const UserAvatarMenu = observer(function UserAvatarMenu({ onClose }: UserAvatarMenuProps) {
  const { user, signOut } = useAuth()
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)

  const handleSignOut = useCallback(async () => {
    setIsOpen(false)
    onClose?.()
    try { await signOut() } catch {}
    router.replace('/(auth)/sign-in')
  }, [signOut, router, onClose])

  const handleProfile = useCallback(() => {
    setIsOpen(false)
    onClose?.()
    router.push('/(app)/settings' as any)
  }, [router, onClose])

  return (
    <View className="flex-row items-center gap-2 p-2 px-3 border-t border-border">
      <Menu
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onOpen={() => setIsOpen(true)}
        placement="top left"
        trigger={(triggerProps) => (
          <Pressable
            {...triggerProps}
            className="rounded-full active:opacity-80"
          >
            <Avatar size="sm">
              {user?.image && <AvatarImage source={{ uri: user.image }} />}
              <AvatarFallbackText>{getInitials(user?.name)}</AvatarFallbackText>
            </Avatar>
          </Pressable>
        )}
      >
        <View className="px-3 py-2">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {user?.name || 'User'}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {user?.email || ''}
          </Text>
        </View>

        <MenuSeparator />

        <MenuItem onPress={handleProfile}>
          <User size={16} className="text-muted-foreground mr-2" />
          <MenuItemLabel>Profile</MenuItemLabel>
        </MenuItem>

        <MenuItem onPress={handleSignOut}>
          <LogOut size={16} className="text-muted-foreground mr-2" />
          <MenuItemLabel>Sign Out</MenuItemLabel>
        </MenuItem>
      </Menu>
    </View>
  )
})

// ---------------------------------------------------------------------------
// AppSidebar (main export)
// ---------------------------------------------------------------------------

interface AppSidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export const AppSidebar = observer(function AppSidebar({ isOpen, onClose }: AppSidebarProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const router = useRouter()
  const projects = useProjectCollection()
  const isWide = width >= 768

  const isHomePage = pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'

  const isActive = useCallback((path: string) => {
    if (path === '/') return isHomePage
    return pathname === path || pathname.startsWith(path + '/')
  }, [pathname, isHomePage])

  const nav = useCallback((href: string) => {
    router.push(href as any)
    if (!isWide) onClose?.()
  }, [router, isWide, onClose])

  const recentProjects = useMemo(() => {
    return [...projects.all]
      .sort((a: any, b: any) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, 5)
  }, [projects.all])

  const handleOpenDocs = useCallback(() => {
    Linking.openURL('https://docs.shogo.ai/')
  }, [])

  const sidebarContent = (
    <View className="flex-1 bg-card border-r border-border">
      {/* Logo header */}
      <View className="h-14 border-b border-border flex-row items-center justify-between px-4">
        <Pressable onPress={() => nav('/(app)')} className="flex-row items-center gap-2">
          <View className="h-8 w-8 rounded-lg bg-blue-600 items-center justify-center">
            <Text className="text-white font-bold text-sm">S</Text>
          </View>
          <Text className="font-semibold text-foreground">Shogo</Text>
        </Pressable>
        {!isWide && (
          <Pressable onPress={onClose} className="p-1 rounded-md active:bg-muted">
            <X size={20} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      {/* Workspace switcher */}
      <WorkspaceSwitcher onClose={!isWide ? onClose : undefined} />

      {/* Main navigation - scrollable */}
      <ScrollView className="flex-1 py-2" showsVerticalScrollIndicator={false}>
        {/* Primary nav */}
        <View>
          <NavItem
            icon={Home}
            label="Home"
            active={isHomePage}
            onPress={() => nav('/(app)')}
          />
          <NavItem
            icon={Search}
            label="Search"
            onPress={() => {}}
          />
        </View>

        {/* PROJECTS section */}
        <NavSection title="Projects">
          <View>
            <ExpandableNavItem
              icon={Clock}
              label="Recent"
              onPress={() => nav('/(app)')}
              defaultExpanded={true}
            >
              {recentProjects.map((project: any) => (
                <ProjectItem
                  key={project.id}
                  name={project.name}
                  projectId={project.id}
                  onPress={() => nav(`/(app)/projects/${project.id}`)}
                />
              ))}
            </ExpandableNavItem>

            <ExpandableNavItem
              icon={LayoutGrid}
              label="All projects"
              active={isActive('/(app)/projects')}
              onPress={() => nav('/(app)/projects')}
              defaultExpanded={false}
            />

            <NavItem
              icon={Star}
              label="Starred"
              active={isActive('/(app)/starred')}
              onPress={() => nav('/(app)/starred')}
            />
            <NavItem
              icon={Users}
              label="Shared with me"
              active={isActive('/(app)/shared')}
              onPress={() => nav('/(app)/shared')}
            />
          </View>
        </NavSection>

        {/* RESOURCES section */}
        <NavSection title="Resources">
          <View>
            <NavItem
              icon={FileCode2}
              label="Templates"
              active={isActive('/(app)/templates')}
              onPress={() => nav('/(app)/templates')}
            />
            <NavItem
              icon={ExternalLink}
              label="Docs"
              onPress={handleOpenDocs}
              external
            />
          </View>
        </NavSection>
      </ScrollView>

      {/* Bottom - user avatar */}
      <UserAvatarMenu onClose={!isWide ? onClose : undefined} />
    </View>
  )

  if (isWide) {
    return (
      <View className="w-64 h-full">
        {sidebarContent}
      </View>
    )
  }

  if (!isOpen) return null

  return (
    <View className="absolute inset-0 z-50 flex-row">
      <Pressable
        onPress={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <View className="w-72 h-full z-10">
        {sidebarContent}
      </View>
    </View>
  )
})
