/**
 * AppSidebar - Responsive navigation sidebar for mobile/tablet/web
 *
 * On wide screens (>= 768px): persistent sidebar pinned to the left
 * On narrow screens (< 768px): slide-over drawer with backdrop overlay
 */

import { useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  useWindowDimensions,
} from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import {
  Home,
  FolderKanban,
  Star,
  Users,
  LayoutTemplate,
  User,
  CreditCard,
  Settings,
  X,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface NavItem {
  icon: React.ElementType
  label: string
  href: string
}

const mainNavItems: NavItem[] = [
  { icon: Home, label: 'Home', href: '/(app)' },
  { icon: FolderKanban, label: 'Projects', href: '/(app)/projects' },
  { icon: Star, label: 'Starred', href: '/(app)/starred' },
  { icon: Users, label: 'Shared', href: '/(app)/shared' },
  { icon: LayoutTemplate, label: 'Templates', href: '/(app)/templates' },
]

const bottomNavItems: NavItem[] = [
  { icon: User, label: 'Profile', href: '/(app)/settings' },
  { icon: CreditCard, label: 'Billing', href: '/(app)/billing' },
  { icon: Users, label: 'Members', href: '/(app)/members' },
  { icon: Settings, label: 'Settings', href: '/(app)/settings' },
]

interface NavItemRowProps {
  item: NavItem
  isActive: boolean
  onPress?: () => void
}

function NavItemRow({ item, isActive, onPress }: NavItemRowProps) {
  const Icon = item.icon
  const router = useRouter()

  const handlePress = useCallback(() => {
    router.push(item.href as any)
    onPress?.()
  }, [item.href, router, onPress])

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        'flex-row items-center gap-3 rounded-lg px-3 py-2.5 mx-2',
        isActive
          ? 'bg-primary/10'
          : 'active:bg-muted'
      )}
    >
      <Icon
        size={20}
        className={cn(
          isActive ? 'text-primary' : 'text-muted-foreground'
        )}
      />
      <Text
        className={cn(
          'text-sm font-medium',
          isActive ? 'text-primary' : 'text-foreground'
        )}
      >
        {item.label}
      </Text>
    </Pressable>
  )
}

function isRouteActive(pathname: string, href: string): boolean {
  if (href === '/(app)') {
    return pathname === '/' || pathname === '/(app)' || pathname === '/(app)/index'
  }
  return pathname.startsWith(href)
}

interface AppSidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export function AppSidebar({ isOpen, onClose }: AppSidebarProps) {
  const { width } = useWindowDimensions()
  const pathname = usePathname()
  const isWide = width >= 768

  const sidebarContent = (
    <View className="flex-1 bg-card border-r border-border">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
        <Text className="text-lg font-bold text-foreground">Shogo</Text>
        {!isWide && (
          <Pressable onPress={onClose} className="p-1 rounded-md active:bg-muted">
            <X size={20} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>

      {/* Main navigation */}
      <ScrollView className="flex-1 pt-2" showsVerticalScrollIndicator={false}>
        <View className="gap-0.5">
          {mainNavItems.map((item) => (
            <NavItemRow
              key={item.href}
              item={item}
              isActive={isRouteActive(pathname, item.href)}
              onPress={!isWide ? onClose : undefined}
            />
          ))}
        </View>
      </ScrollView>

      {/* Bottom navigation */}
      <View className="border-t border-border pt-2 pb-4 gap-0.5">
        {bottomNavItems.map((item) => (
          <NavItemRow
            key={item.label}
            item={item}
            isActive={isRouteActive(pathname, item.href)}
            onPress={!isWide ? onClose : undefined}
          />
        ))}
      </View>
    </View>
  )

  // Wide screens: persistent sidebar
  if (isWide) {
    return (
      <View className="w-64 h-full">
        {sidebarContent}
      </View>
    )
  }

  // Narrow screens: drawer overlay
  if (!isOpen) return null

  return (
    <View className="absolute inset-0 z-50 flex-row">
      {/* Backdrop */}
      <Pressable
        onPress={onClose}
        className="absolute inset-0 bg-black/50"
      />
      {/* Drawer panel */}
      <View className="w-72 h-full z-10">
        {sidebarContent}
      </View>
    </View>
  )
}
