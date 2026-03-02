/**
 * Settings Page - Mobile (Expo)
 *
 * Lovable-style sidebar navigation (desktop) / horizontal tabs (mobile):
 * - Workspace: Name, avatar, danger zone
 * - People: Workspace members
 * - Account: Profile, email, preferences
 * - Billing: Plan & credits
 * - Labs: Experimental features
 * - GitHub: Source control connector
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  Modal,
  ActivityIndicator,
  Alert as RNAlert,
  Linking,
  Platform,
  useWindowDimensions,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Settings,
  Building2,
  Users,
  CreditCard,
  Shield,
  User,
  FlaskConical,
  Github,
  ExternalLink,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronRight,
  Check,
  Sparkles,
  MapPin,
  BookOpen,
  MessageSquare,
  X,
  Search,
  UserPlus,
  Mail,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import {
  useDomain,
  useWorkspaceCollection,
  useMemberCollection,
  useInvitationCollection,
  useDomainHttp,
  type IDomainStore,
} from '../../contexts/domain'
import { useDomainActions } from '@shogo/shared-app/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
import {
  PRO_TIERS,
  BUSINESS_TIERS,
  PRO_FEATURES,
  BUSINESS_FEATURES,
  ENTERPRISE_FEATURES,
  BASE_TIER_CREDITS,
  getTotalCreditsForPlan as getBillingCreditsTotal,
  formatCredits,
} from '../../lib/billing-config'
import { TierSelector } from '../../components/billing/TierSelector'
import { FeatureList } from '../../components/billing/FeatureList'
import {
  Card,
  CardContent,
  Button,
  Input,
  Badge,
  Separator,
  Switch,
  Progress,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

const DOCS_URL = 'https://docs.shogo.ai'

type TabId = 'workspace' | 'people' | 'account' | 'billing' | 'labs' | 'github'

const ALL_TAB_IDS: TabId[] = ['workspace', 'people', 'account', 'billing', 'labs', 'github']

interface NavItem {
  id: TabId
  label: string
  icon: React.ElementType
}

const MOBILE_NAV_ITEMS: NavItem[] = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'people', label: 'People', icon: Users },
  { id: 'account', label: 'Account', icon: User },
  { id: 'billing', label: 'Plans & Credits', icon: CreditCard },
  { id: 'labs', label: 'Labs', icon: FlaskConical },
  { id: 'github', label: 'GitHub', icon: Github },
]

function TabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="border-b border-border"
      contentContainerClassName="px-4"
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const isActive = activeTab === item.id
        return (
          <Pressable
            key={item.id}
            onPress={() => onTabChange(item.id)}
            className={cn(
              'flex-row items-center gap-2 px-3 py-3 mr-1',
              isActive ? 'border-b-2 border-primary' : ''
            )}
          >
            <Icon
              size={16}
              className={isActive ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text
              className={cn(
                'text-sm font-medium',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {item.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

interface SidebarItem {
  id: TabId
  label: string
  avatar?: string
}

interface SidebarSection {
  id: string
  label?: string
  items: SidebarItem[]
}

function SettingsSidebar({
  activeTab,
  onTabChange,
  workspaceName,
  userName,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  workspaceName: string
  userName: string
}) {
  const router = useRouter()

  const sections: SidebarSection[] = [
    {
      id: 'workspace',
      label: 'Workspace',
      items: [
        { id: 'workspace', label: workspaceName || 'Workspace', avatar: (workspaceName?.[0] || 'W').toUpperCase() },
        { id: 'people', label: 'People' },
        { id: 'billing', label: 'Plans & credits' },
      ],
    },
    {
      id: 'account',
      label: 'Account',
      items: [
        { id: 'account', label: userName || 'Account' },
      ],
    },
    {
      id: 'labs-standalone',
      items: [
        { id: 'labs', label: 'Labs' },
      ],
    },
    {
      id: 'connectors',
      label: 'Connectors',
      items: [
        { id: 'github', label: 'GitHub' },
      ],
    },
  ]

  return (
    <View className="w-[210px] pt-4 pb-3 px-3">
      <Pressable
        onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/projects')}
        className="flex-row items-center gap-1 px-2 py-1.5 mb-4"
      >
        <ArrowLeft size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Go back</Text>
      </Pressable>

      {sections.map((section, sectionIdx) => (
        <View key={section.id} className={sectionIdx > 0 ? 'mt-6' : ''}>
          {section.label && (
            <Text className="text-xs font-medium text-muted-foreground px-2 mb-1">
              {section.label}
            </Text>
          )}
          <View className="gap-0.5">
          {section.items.map((item) => {
            const isActive = activeTab === item.id
            return (
              <Pressable
                key={item.id}
                onPress={() => onTabChange(item.id)}
                className={cn(
                  'flex-row items-center gap-2 px-2 py-2 rounded-md',
                  isActive ? 'bg-muted' : ''
                )}
              >
                {item.avatar && (
                  <View className="h-5 w-5 rounded bg-primary items-center justify-center">
                    <Text className="text-[10px] font-semibold text-primary-foreground">
                      {item.avatar}
                    </Text>
                  </View>
                )}
                <Text
                  className={cn(
                    'text-sm flex-1',
                    isActive ? 'text-foreground font-medium' : 'text-muted-foreground'
                  )}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
              </Pressable>
            )
          })}
          </View>
        </View>
      ))}
    </View>
  )
}

// ============================================================================
// WORKSPACE SETTINGS TAB
// ============================================================================

function WorkspaceSettingsTab() {
  const router = useRouter()
  const store = useDomain() as IDomainStore
  const actions = useDomainActions()
  const { user } = useAuth()
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()

  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const [name, setName] = useState(currentWorkspace?.name || '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  const originalName = currentWorkspace?.name || ''
  const hasChanges = name !== originalName
  const isValid = name.trim().length > 0 && name.length <= 60

  const currentUserId = user?.id
  const workspaceMembers = currentWorkspace?.id
    ? members.all.filter(
        (m: any) => m.workspaceId === currentWorkspace.id && !m.projectId
      )
    : []
  const currentUserMember = workspaceMembers.find(
    (m: any) => m.userId === currentUserId
  )
  const isOwner = currentUserMember?.role === 'owner'

  const isPersonalWorkspace =
    currentWorkspace?.slug?.includes('personal') ||
    currentWorkspace?.name?.toLowerCase().includes('personal')

  const canDelete = isOwner && workspaces.all.length > 1 && !isPersonalWorkspace
  const deleteConfirmRequired = currentWorkspace?.name || 'delete'
  const isDeleteConfirmed = deleteConfirmText === deleteConfirmRequired

  useEffect(() => {
    setName(currentWorkspace?.name || '')
    setSaveStatus('idle')
  }, [currentWorkspace?.name])

  const handleSave = async () => {
    if (!hasChanges || !isValid || !currentWorkspace?.id) return
    setIsSaving(true)
    setSaveStatus('idle')
    try {
      await actions.updateWorkspace(currentWorkspace.id, { name: name.trim() })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (error) {
      console.error('Failed to save workspace name:', error)
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace?.id || !isDeleteConfirmed) return
    setIsDeleting(true)
    try {
      await actions.deleteWorkspaceWithMembers(currentWorkspace.id)
      setIsDeleteDialogOpen(false)
      router.replace('/(app)')
    } catch (error) {
      console.error('Failed to delete workspace:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">
          Workspace settings
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Workspaces allow you to collaborate on projects in real time.
        </Text>
      </View>

      <Card>
        <CardContent className="p-0">
          {/* Avatar */}
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-base font-semibold text-foreground">
                Avatar
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Set an avatar for your workspace.
              </Text>
            </View>
            <View className="h-10 w-10 rounded-lg bg-primary items-center justify-center">
              <Text className="text-sm font-semibold text-primary-foreground">
                {currentWorkspace?.name?.[0]?.toUpperCase() || 'W'}
              </Text>
            </View>
          </View>

          <Separator />

          {/* Name */}
          <View className="px-6 py-5 flex-row items-start justify-between">
            <View className="flex-[0.45] mr-4 pt-1">
              <Text className="text-base font-semibold text-foreground">
                Name
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Your full workspace name, as visible to others.
              </Text>
            </View>
            <View className="flex-[0.55]">
              <View className="flex-row gap-2 items-start">
                <View className="flex-1">
                  <Input
                    value={name}
                    onChangeText={(t) => {
                      setName(t)
                      setSaveStatus('idle')
                    }}
                  />
                </View>
                <Button
                  onPress={handleSave}
                  disabled={!hasChanges || !isValid || isSaving}
                  size="sm"
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </View>
              <Text className="text-xs text-muted-foreground mt-1.5 text-right">
                {name.length} / 60 characters
              </Text>
              {saveStatus === 'saved' && (
                <Text className="text-xs text-green-600 mt-1">
                  Changes saved successfully!
                </Text>
              )}
              {saveStatus === 'error' && (
                <Text className="text-xs text-destructive mt-1">
                  Failed to save changes. Please try again.
                </Text>
              )}
            </View>
          </View>

          <Separator />

          {/* Username */}
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-base font-semibold text-foreground">
                Username
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Set a username for the workspace profile page.
              </Text>
            </View>
            <Button variant="outline" size="sm">
              Set username
            </Button>
          </View>

          <Separator />

          {/* Default monthly member credit limit */}
          <View className="px-6 py-5 flex-row items-start justify-between">
            <View className="flex-[0.45] mr-4 pt-1">
              <Text className="text-base font-semibold text-foreground">
                Default monthly member credit limit
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                The default monthly credit limit for members of this workspace. Leave empty to use no limit.
              </Text>
            </View>
            <View className="flex-[0.55]">
              <Input
                placeholder="Enter default monthly member credit limit (optional)"
              />
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Leave workspace */}
      <Card>
        <CardContent className="p-0">
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-base font-semibold text-foreground">
                Leave workspace
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                You cannot leave your last workspace. Your account must be a member of at least one workspace.
              </Text>
            </View>
            <Button variant="outline" size="sm" disabled>
              Leave workspace
            </Button>
          </View>

          {isOwner && (
            <>
              <Separator />
              <View className="px-6 py-5 flex-row items-center justify-between">
                <View className="flex-1 mr-4">
                  <Text className="text-base font-semibold text-destructive">
                    Delete workspace
                  </Text>
                  <Text className="text-sm text-muted-foreground mt-0.5">
                    {canDelete
                      ? 'Permanently delete this workspace and all its data.'
                      : isPersonalWorkspace
                      ? 'Your personal workspace cannot be deleted.'
                      : 'You cannot delete your only workspace.'}
                  </Text>
                </View>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!canDelete}
                  onPress={() => setIsDeleteDialogOpen(true)}
                >
                  Delete
                </Button>
              </View>
            </>
          )}
        </CardContent>
      </Card>

      {/* Delete Workspace Confirmation Modal */}
      <Modal
        visible={isDeleteDialogOpen}
        transparent
        animationType="fade"
        onRequestClose={() => { setIsDeleteDialogOpen(false); setDeleteConfirmText('') }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => { setIsDeleteDialogOpen(false); setDeleteConfirmText('') }}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-destructive">
                Delete workspace
              </Text>
              <Pressable onPress={() => { setIsDeleteDialogOpen(false); setDeleteConfirmText('') }} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground">
              This action cannot be undone. This will permanently delete the
              workspace "{currentWorkspace?.name}".
            </Text>
            <Text className="text-sm text-muted-foreground">
              Please type "{deleteConfirmRequired}" to confirm.
            </Text>
            <Input
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              placeholder={`Type "${deleteConfirmRequired}" to confirm`}
            />
            <View className="flex-row gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  setIsDeleteDialogOpen(false)
                  setDeleteConfirmText('')
                }}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onPress={handleDeleteWorkspace}
                disabled={!isDeleteConfirmed || isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete workspace'}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

// ============================================================================
// ACCOUNT TAB
// ============================================================================

const CHAT_SUGGESTIONS_KEY = 'shogo:chat-suggestions'

function AccountTab() {
  const { user, signOut, updateUser } = useAuth()
  const http = useDomainHttp()
  const router = useRouter()

  const [name, setName] = useState(user?.name || '')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [chatSuggestions, setChatSuggestions] = useState(true)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  const originalName = user?.name || ''
  const hasNameChanges = name !== originalName
  const hasChanges = hasNameChanges

  useEffect(() => {
    setName(user?.name || '')
  }, [user?.name])

  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(CHAT_SUGGESTIONS_KEY)
      if (stored !== null) setChatSuggestions(stored !== 'false')
    }
  }, [])

  const handleToggleChatSuggestions = useCallback((value: boolean) => {
    setChatSuggestions(value)
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.localStorage.setItem(CHAT_SUGGESTIONS_KEY, String(value))
    }
  }, [])

  const handleSave = async () => {
    if (!hasChanges || isSaving || !user?.id) return
    if (hasNameChanges && !name.trim()) return
    setIsSaving(true)
    setSaveStatus('idle')
    try {
      await updateUser({ name: name.trim() })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (error) {
      console.error('Failed to save account settings:', error)
      setSaveStatus('error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSignOut = async () => {
    await signOut()
    router.replace('/(auth)/sign-in')
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE' || !user?.id || !http) return
    setIsDeleting(true)
    try {
      await http.delete(`/api/users/${user.id}`)
      await signOut()
      router.replace('/(auth)/sign-in')
    } catch (error) {
      console.error('Failed to delete account:', error)
      if (Platform.OS === 'web') {
        window.alert('Failed to delete account. Please try again.')
      } else {
        RNAlert.alert('Error', 'Failed to delete account. Please try again.')
      }
    } finally {
      setIsDeleting(false)
      setIsDeleteDialogOpen(false)
      setDeleteConfirmText('')
    }
  }

  const handleLinkCompany = () => {
    if (Platform.OS === 'web') {
      window.alert('SSO linking is coming soon.')
    } else {
      RNAlert.alert('Coming Soon', 'SSO linking is coming soon.')
    }
  }

  const handleVerify2FA = () => {
    if (Platform.OS === 'web') {
      window.alert('Two-factor authentication is coming soon.')
    } else {
      RNAlert.alert('Coming Soon', 'Two-factor authentication is coming soon.')
    }
  }

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">
          Account settings
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Personalize how others see and interact with you on Shogo.
        </Text>
      </View>

      {/* Activity heatmap */}
      <Card>
        <CardContent className="p-5 gap-3">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm text-foreground">0 edits on</Text>
            <Sparkles size={16} className="text-primary" />
            <Text className="text-sm font-bold text-foreground">Shogo</Text>
            <Text className="text-sm text-foreground">in the last year</Text>
          </View>
          <View className="h-20 bg-muted/50 rounded items-center justify-center">
            <Text className="text-xs text-muted-foreground">
              Activity heatmap coming soon
            </Text>
          </View>
          <View className="flex-row gap-4">
            <View className="flex-1">
              <Text className="text-xs text-muted-foreground">Daily average</Text>
              <Text className="text-sm font-medium text-foreground">0.0 edits</Text>
            </View>
            <View className="flex-1">
              <Text className="text-xs text-muted-foreground">Days edited</Text>
              <Text className="text-sm font-medium text-foreground">0 (0%)</Text>
            </View>
            <View className="flex-1">
              <Text className="text-xs text-muted-foreground">Current streak</Text>
              <Text className="text-sm font-medium text-foreground">0 days</Text>
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Profile */}
      <Card>
        <CardContent className="p-0">
          {/* Avatar */}
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-semibold text-foreground">
                Avatar
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Your avatar is fetched from your identity provider or
                automatically generated.
              </Text>
            </View>
            <View className="h-10 w-10 rounded-full bg-primary items-center justify-center">
              <Text className="text-sm font-semibold text-primary-foreground">
                {user?.name?.[0]?.toUpperCase() || 'U'}
              </Text>
            </View>
          </View>

          <Separator />

          {/* Username */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">
              Username
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your public identifier and profile URL.
            </Text>
            <View className="flex-row gap-3 items-start mt-3">
              <View className="flex-1">
                <Input
                  value={name}
                  onChangeText={(t) => {
                    setName(t)
                    setSaveStatus('idle')
                  }}
                  placeholder="Enter a username"
                />
              </View>
              <Button
                variant="outline"
                size="sm"
                onPress={handleSave}
                disabled={!hasNameChanges || !name.trim() || isSaving}
              >
                {isSaving ? 'Saving...' : 'Update'}
              </Button>
            </View>
            {saveStatus === 'saved' && (
              <Text className="text-xs text-green-600 mt-1">
                Updated successfully!
              </Text>
            )}
            {saveStatus === 'error' && (
              <Text className="text-xs text-destructive mt-1">
                Failed to update. Please try again.
              </Text>
            )}
          </View>

          <Separator />

          {/* Email */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">Email</Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your email address associated with your account.
            </Text>
            <Input className="mt-3" value={user?.email || ''} disabled />
          </View>

          <Separator />

          {/* Name */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">Name</Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your full name, as visible to others.
            </Text>
            <Input
              className="mt-3"
              value={name}
              onChangeText={(t) => {
                setName(t)
                setSaveStatus('idle')
              }}
              placeholder="Enter your name"
            />
          </View>
        </CardContent>
      </Card>

      {/* Preferences */}
      <Card>
        <CardContent className="p-0">
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-semibold text-foreground">
                Chat suggestions
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Show helpful suggestions in the chat interface.
              </Text>
            </View>
            <Switch
              checked={chatSuggestions}
              onCheckedChange={handleToggleChatSuggestions}
            />
          </View>
        </CardContent>
      </Card>

      {/* Linked accounts */}
      <Card>
        <CardContent className="p-0">
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">
              Linked accounts
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Manage accounts linked for sign-in.
            </Text>
            <View className="mt-3 gap-3">
              <View className="bg-muted/50 rounded-lg p-3 flex-row items-center gap-3">
                <View className="h-8 w-8 rounded bg-muted items-center justify-center">
                  <User size={16} className="text-muted-foreground" />
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text className="text-sm font-medium text-foreground">
                      Password
                    </Text>
                    <Badge variant="secondary">
                      <Text className="text-[10px] text-secondary-foreground">
                        Primary
                      </Text>
                    </Badge>
                  </View>
                  <Text className="text-xs text-muted-foreground">{user?.email}</Text>
                </View>
              </View>
              <View className="border border-dashed border-border rounded-lg p-3 flex-row items-center gap-3">
                <View className="h-8 w-8 rounded bg-muted items-center justify-center">
                  <Building2 size={16} className="text-muted-foreground" />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">
                    Link company account
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    Use your organization's single sign-on
                  </Text>
                </View>
                <Button variant="outline" size="sm" onPress={handleLinkCompany}>
                  Link
                </Button>
              </View>
            </View>
          </View>

          <Separator />

          {/* Two-factor authentication */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">
              Two-factor authentication
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Secure your account with a one-time code via an authenticator app
              or SMS.
            </Text>
            <View className="mt-3 bg-muted/50 rounded-lg p-3 flex-row items-center gap-3">
              <Shield size={20} className="text-muted-foreground" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  Re-authentication required
                </Text>
                <Text className="text-xs text-muted-foreground">
                  For security, please re-authenticate to manage two-factor
                  settings.
                </Text>
              </View>
              <Button variant="outline" size="sm" onPress={handleVerify2FA}>
                Verify
              </Button>
            </View>
          </View>

          <Separator />

          {/* Delete account */}
          <View className="px-6 py-5">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-sm font-semibold text-foreground">
                  Delete account
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">
                  Permanently delete your Shogo account. This cannot be undone.
                </Text>
              </View>
              <Button
                variant="destructive"
                size="sm"
                onPress={() => setIsDeleteDialogOpen(true)}
              >
                Delete
              </Button>
            </View>
            {isDeleteDialogOpen && (
              <View className="mt-4 p-4 border border-destructive/30 rounded-lg bg-destructive/5">
                <Text className="text-sm text-foreground font-medium">
                  Are you sure? This action is irreversible.
                </Text>
                <Text className="text-sm text-muted-foreground mt-1">
                  Type "DELETE" to confirm.
                </Text>
                <Input
                  className="mt-2"
                  value={deleteConfirmText}
                  onChangeText={setDeleteConfirmText}
                  placeholder='Type "DELETE"'
                />
                <View className="flex-row gap-2 mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => {
                      setIsDeleteDialogOpen(false)
                      setDeleteConfirmText('')
                    }}
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onPress={handleDeleteAccount}
                    disabled={deleteConfirmText !== 'DELETE' || isDeleting}
                  >
                    {isDeleting ? 'Deleting...' : 'Permanently delete'}
                  </Button>
                </View>
              </View>
            )}
          </View>
        </CardContent>
      </Card>

      {/* Sign Out */}
      <Button variant="destructive" onPress={handleSignOut} className="w-full">
        Sign Out
      </Button>

      {/* Save changes bar */}
      {hasChanges && (
        <View className="bg-background border-t border-border px-4 py-3 flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">
            You have unsaved changes
          </Text>
          <View className="flex-row items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => setName(originalName)}
              disabled={isSaving}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onPress={handleSave}
              disabled={!hasChanges || (hasNameChanges && !name.trim()) || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          </View>
        </View>
      )}
    </View>
  )
}

// ============================================================================
// BILLING TAB — Lovable-style layout
// ============================================================================

function BillingTab() {
  const { user } = useAuth()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()
  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const {
    subscription,
    effectiveBalance,
    isLoading: isBillingLoading,
  } = useBillingData(currentWorkspace?.id)

  const [selectedProTier, setSelectedProTier] = useState(0)
  const [selectedBusinessTier, setSelectedBusinessTier] = useState(0)
  const [proAnnual, setProAnnual] = useState(false)
  const [businessAnnual, setBusinessAnnual] = useState(false)
  const [isCheckoutLoading, setIsCheckoutLoading] = useState<string | null>(null)
  const [isPortalLoading, setIsPortalLoading] = useState(false)

  const planLabel = subscription
    ? subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)
    : 'Free'

  const creditsTotal = getBillingCreditsTotal(subscription?.planId)
  const creditsRemaining = effectiveBalance?.total ?? creditsTotal

  const proTier = PRO_TIERS[selectedProTier]
  const businessTier = BUSINESS_TIERS[selectedBusinessTier]

  const handleCheckout = useCallback(
    async (planType: 'pro' | 'business', credits: number, annual: boolean) => {
      if (!currentWorkspace?.id) return
      setIsCheckoutLoading(planType)
      try {
        const planId = credits === BASE_TIER_CREDITS ? planType : `${planType}_${credits}`
        const data = await actions.createCheckoutSession({
          workspaceId: currentWorkspace.id,
          planId,
          billingInterval: annual ? 'annual' : 'monthly',
          userEmail: user?.email,
        })
        if (data.url) {
          if (Platform.OS === 'web') {
            window.location.href = data.url
          } else {
            Linking.openURL(data.url)
          }
        }
      } catch (e) {
        console.warn('Checkout failed:', e)
      } finally {
        setIsCheckoutLoading(null)
      }
    },
    [actions, currentWorkspace?.id, user?.email],
  )

  const handleManageSubscription = useCallback(async () => {
    if (!currentWorkspace?.id) return
    setIsPortalLoading(true)
    try {
      const returnUrl = Platform.OS === 'web' ? window.location.href : undefined
      const data = await actions.createPortalSession(currentWorkspace.id, returnUrl)
      if (data.url) {
        if (Platform.OS === 'web') {
          window.location.href = data.url
        } else {
          Linking.openURL(data.url)
        }
      }
    } catch (e) {
      console.warn('Portal session failed:', e)
    } finally {
      setIsPortalLoading(false)
    }
  }, [actions, currentWorkspace?.id])

  if (isBillingLoading) {
    return (
      <View className="items-center justify-center py-20">
        <ActivityIndicator />
        <Text className="mt-2 text-sm text-muted-foreground">Loading billing...</Text>
      </View>
    )
  }

  return (
    <View className="gap-8">
      {/* Header */}
      <View>
        <Text className="text-xl font-semibold text-foreground">Plans & credits</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Manage your subscription plan and credit balance.
        </Text>
      </View>

      {/* Current plan + Credits remaining — side-by-side on desktop */}
      <View className="gap-4 md:flex-row">
        <Card className="md:flex-1">
          <CardContent className="p-5 gap-4">
            <View className="flex-row items-center gap-3">
              <View className="h-10 w-10 rounded-lg bg-primary/10 items-center justify-center">
                <Sparkles size={20} className="text-primary" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  You're on {planLabel} Plan
                </Text>
                <Text className="text-sm text-muted-foreground">Upgrade anytime</Text>
              </View>
            </View>
            <Button
              variant="outline"
              size="sm"
              onPress={handleManageSubscription}
              disabled={isPortalLoading}
              className="self-start"
            >
              {isPortalLoading ? 'Loading...' : 'Manage'}
            </Button>
          </CardContent>
        </Card>

        <Card className="md:flex-1">
          <CardContent className="p-5 gap-3">
            <View className="flex-row justify-between items-center">
              <Text className="text-sm text-muted-foreground">Credits remaining</Text>
              <Text className="text-sm font-medium text-foreground">
                {formatCredits(creditsRemaining)} of {creditsTotal}
              </Text>
            </View>
            <Progress
              value={(creditsRemaining / Math.max(creditsTotal, 1)) * 100}
              className="h-2"
            />
            <View className="gap-1.5">
              <View className="flex-row items-center gap-2">
                <View className="h-2 w-2 rounded-full bg-primary" />
                <Text className="text-xs text-muted-foreground">Daily credits used first</Text>
              </View>
              <View className="flex-row items-center gap-2">
                {subscription ? (
                  <>
                    <Check size={12} className="text-foreground" />
                    <Text className="text-xs text-muted-foreground">Credits will rollover</Text>
                  </>
                ) : (
                  <>
                    <X size={12} className="text-muted-foreground" />
                    <Text className="text-xs text-muted-foreground">No credits will rollover</Text>
                  </>
                )}
              </View>
              <View className="flex-row items-center gap-2">
                <Check size={12} className="text-foreground" />
                <Text className="text-xs text-muted-foreground">
                  Daily credits reset at midnight UTC
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>
      </View>

      {/* Plan cards — 3 columns on desktop, stacked on mobile */}
      <View className="gap-6 md:flex-row md:items-start">
        {/* Pro */}
        <Card className="md:flex-1 md:w-0">
          <CardContent className="p-5 gap-4">
            <Text className="text-lg font-semibold text-foreground">Pro</Text>
            <Text className="text-sm text-muted-foreground">
              Designed for fast-moving teams building together in real time.
            </Text>
            <View>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-3xl font-bold text-foreground">
                  ${proAnnual ? Math.round(proTier.annual / 12) : proTier.monthly}
                </Text>
                <Text className="text-sm text-muted-foreground">per month</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                shared across unlimited users
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Switch checked={proAnnual} onCheckedChange={setProAnnual} />
              <Text className="text-sm text-foreground">Annual</Text>
            </View>
            <Button
              onPress={() => handleCheckout('pro', proTier.credits, proAnnual)}
              disabled={isCheckoutLoading !== null || subscription?.planId?.startsWith('pro')}
            >
              {isCheckoutLoading === 'pro'
                ? 'Loading...'
                : subscription?.planId?.startsWith('pro')
                  ? 'Current Plan'
                  : 'Upgrade'}
            </Button>
            <TierSelector
              tiers={PRO_TIERS}
              selectedIndex={selectedProTier}
              onSelect={setSelectedProTier}
              suffix=" / month"
            />
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">
                All features in Free, plus:
              </Text>
              <FeatureList features={PRO_FEATURES} />
            </View>
          </CardContent>
        </Card>

        {/* Business */}
        <Card className="md:flex-1 md:w-0">
          <CardContent className="p-5 gap-4">
            <Text className="text-lg font-semibold text-foreground">Business</Text>
            <Text className="text-sm text-muted-foreground">
              Advanced controls and power features for growing departments
            </Text>
            <View>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-3xl font-bold text-foreground">
                  ${businessAnnual ? Math.round(businessTier.annual / 12) : businessTier.monthly}
                </Text>
                <Text className="text-sm text-muted-foreground">per month</Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                shared across unlimited users
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Switch checked={businessAnnual} onCheckedChange={setBusinessAnnual} />
              <Text className="text-sm text-foreground">Annual</Text>
            </View>
            <Button
              variant="outline"
              onPress={() => handleCheckout('business', businessTier.credits, businessAnnual)}
              disabled={isCheckoutLoading !== null || subscription?.planId?.startsWith('business')}
            >
              {isCheckoutLoading === 'business'
                ? 'Loading...'
                : subscription?.planId?.startsWith('business')
                  ? 'Current Plan'
                  : 'Upgrade'}
            </Button>
            <TierSelector
              tiers={BUSINESS_TIERS}
              selectedIndex={selectedBusinessTier}
              onSelect={setSelectedBusinessTier}
              suffix=" / month"
            />
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">
                All features in Pro, plus:
              </Text>
              <FeatureList features={BUSINESS_FEATURES} />
            </View>
          </CardContent>
        </Card>

        {/* Enterprise */}
        <Card className="md:flex-1 md:w-0">
          <CardContent className="p-5 gap-4">
            <Text className="text-lg font-semibold text-foreground">Enterprise</Text>
            <Text className="text-sm text-muted-foreground">
              Built for large orgs needing flexibility, scale, and governance.
            </Text>
            <View>
              <Text className="text-3xl font-bold text-foreground">Custom</Text>
              <Text className="text-sm text-muted-foreground">Flexible plans</Text>
            </View>
            <Button
              variant="outline"
              onPress={() => Linking.openURL('mailto:sales@shogo.ai')}
            >
              Book a demo
            </Button>
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">
                All features in Business, plus:
              </Text>
              <FeatureList features={ENTERPRISE_FEATURES} />
            </View>
          </CardContent>
        </Card>
      </View>
    </View>
  )
}

// ============================================================================
// LABS TAB
// ============================================================================

const LABS_BRANCH_SWITCHING_KEY = 'shogo:labs-github-branch-switching'

function LabsTab() {
  const [githubBranchSwitching, setGithubBranchSwitching] = useState(false)

  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(LABS_BRANCH_SWITCHING_KEY)
      if (stored !== null) setGithubBranchSwitching(stored === 'true')
    }
  }, [])

  const handleToggle = useCallback((value: boolean) => {
    setGithubBranchSwitching(value)
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.localStorage.setItem(LABS_BRANCH_SWITCHING_KEY, String(value))
    }
  }, [])

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">Labs</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          These are experimental features that might be modified or removed.
        </Text>
      </View>

      <Card>
        <CardContent className="p-0">
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-semibold text-foreground">
                GitHub branch switching
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Select the branch to make edits to in your GitHub repository.
              </Text>
            </View>
            <Switch
              checked={githubBranchSwitching}
              onCheckedChange={handleToggle}
            />
          </View>
        </CardContent>
      </Card>
    </View>
  )
}

// ============================================================================
// GITHUB TAB
// ============================================================================

function GitHubTab() {
  const [showComingSoon, setShowComingSoon] = useState(false)

  const handleConnect = useCallback(() => {
    setShowComingSoon(true)
    setTimeout(() => setShowComingSoon(false), 3000)
  }, [])

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">GitHub</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Sync your project 2-way with GitHub to collaborate at source.
        </Text>
      </View>

      <Card>
        <CardContent className="p-0">
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-semibold text-foreground">
                  Connected account
                </Text>
                <Badge variant="secondary">
                  <Text className="text-[10px] text-secondary-foreground">
                    admin
                  </Text>
                </Badge>
              </View>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Add your GitHub account to manage connected organizations.
              </Text>
            </View>
            <Pressable
              onPress={handleConnect}
              className="border border-input bg-background rounded-md h-9 px-3 flex-row items-center justify-center"
            >
              <Text className="text-sm font-medium text-foreground">
                Connect
              </Text>
            </Pressable>
          </View>
          {showComingSoon && (
            <View className="px-6 pb-4">
              <Text className="text-sm text-amber-500">
                GitHub integration is coming soon.
              </Text>
            </View>
          )}
        </CardContent>
      </Card>
    </View>
  )
}

// ============================================================================
// PEOPLE TAB — Lovable-style workspace member management
// ============================================================================

type PeopleSubTab = 'all' | 'invitations'

const ROLE_DISPLAY: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Editor',
  viewer: 'Viewer',
}

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-amber-500',
  admin: 'bg-blue-500',
  member: 'bg-emerald-500',
  viewer: 'bg-slate-400',
}

type SortField = 'name' | 'role' | 'joinedDate' | 'usage' | 'totalUsage' | 'creditLimit'
type SortDir = 'asc' | 'desc'

function PeopleTab() {
  const { user } = useAuth()
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()
  const invitations = useInvitationCollection()
  const actions = useDomainActions()
  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const [subTab, setSubTab] = useState<PeopleSubTab>('all')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [showRoleFilter, setShowRoleFilter] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [isLoading, setIsLoading] = useState(true)

  const [resolvedWs, setResolvedWs] = useState<{ id: string; name: string } | null>(null)

  const loadPeopleData = useCallback(async () => {
    setIsLoading(true)
    try {
      if (workspaces.all.length === 0) {
        await workspaces.loadAll({})
      }
      if (workspaces.all.length === 0) {
        await new Promise(r => setTimeout(r, 1500))
        await workspaces.loadAll({})
      }

      const ws = workspaces.all[0]
      if (!ws?.id) { setIsLoading(false); return }
      setResolvedWs({ id: ws.id, name: ws.name || 'Workspace' })

      await members.loadAll({ workspaceId: ws.id })
      await invitations.loadAll({ workspaceId: ws.id })

      if (user?.email) {
        await invitations.loadAll({ email: user.email })
      }
    } catch {}
    setIsLoading(false)
  }, [workspaces, members, invitations, currentWorkspace?.id, user?.email])

  useEffect(() => { loadPeopleData() }, [loadPeopleData])

  const workspaceMembers = currentWorkspace?.id
    ? members.all.filter((m: any) => m.workspaceId === currentWorkspace.id && !m.projectId)
    : []
  const pendingInvitations = currentWorkspace?.id
    ? invitations.all.filter((i: any) => i.workspaceId === currentWorkspace.id && i.status === 'pending')
    : []
  const receivedInvitations = user?.email
    ? invitations.all.filter((i: any) => i.email === user.email && i.status === 'pending')
    : []

  const filteredMembers = useMemo(() => {
    let result = [...workspaceMembers]
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((m: any) =>
        (m.user?.name || '').toLowerCase().includes(q) ||
        (m.user?.email || '').toLowerCase().includes(q) ||
        (m.userId || '').toLowerCase().includes(q)
      )
    }
    if (roleFilter !== 'all') {
      result = result.filter((m: any) => m.role === roleFilter)
    }
    result.sort((a: any, b: any) => {
      let cmp = 0
      if (sortField === 'name') cmp = (a.userId || '').localeCompare(b.userId || '')
      else if (sortField === 'role') cmp = (a.role || '').localeCompare(b.role || '')
      else if (sortField === 'joinedDate') cmp = (a.createdAt || 0) - (b.createdAt || 0)
      return sortDir === 'desc' ? -cmp : cmp
    })
    return result
  }, [workspaceMembers, search, roleFilter, sortField, sortDir])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const handleCancelInvitation = async (invitationId: string) => {
    try {
      await actions.cancelInvitation(invitationId)
    } catch {}
  }

  const builderCount = workspaceMembers.length
  const currentMonth = new Date().toLocaleString('default', { month: 'short' })

  const SUB_TABS: { id: PeopleSubTab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'invitations', label: 'Invitations' },
  ]

  const SortArrow = ({ field }: { field: SortField }) => (
    <View className="ml-1">
      <Text className={cn('text-[8px]', sortField === field && sortDir === 'asc' ? 'text-foreground' : 'text-muted-foreground/40')}>▲</Text>
      <Text className={cn('text-[8px] -mt-1', sortField === field && sortDir === 'desc' ? 'text-foreground' : 'text-muted-foreground/40')}>▼</Text>
    </View>
  )

  return (
    <View className="gap-0">
      {/* Header */}
      <View className="mb-6">
        <Text className="text-xl font-semibold text-foreground">People</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Inviting people to{' '}
          <Text className="font-semibold text-foreground">
            {resolvedWs?.name || currentWorkspace?.name || 'your workspace'}
          </Text>{' '}
          gives access to workspace shared projects and credits.{' '}
          You have {builderCount} builder{builderCount !== 1 ? 's' : ''} in this workspace.
        </Text>
      </View>

      {/* Sub-tabs */}
      <View className="flex-row border-b border-border mb-4">
        {SUB_TABS.map((tab) => (
          <Pressable
            key={tab.id}
            onPress={() => setSubTab(tab.id)}
            className={cn(
              'px-4 py-2.5 mr-1',
              subTab === tab.id
                ? 'border-b-2 border-foreground'
                : ''
            )}
          >
            <Text
              className={cn(
                'text-sm',
                subTab === tab.id
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground'
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Controls row */}
      <View className="flex-row items-center gap-2 mb-4 flex-wrap">
        <View className="flex-row items-center flex-1 min-w-[160px] border border-border rounded-lg px-3 h-9">
          <Search size={14} className="text-muted-foreground mr-2" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search..."
            className="flex-1 text-sm text-foreground placeholder:text-muted-foreground web:outline-none"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View className="relative">
          <Pressable
            onPress={() => setShowRoleFilter(!showRoleFilter)}
            className="flex-row items-center h-9 px-3 border border-border rounded-lg gap-1.5"
          >
            <Text className="text-sm text-foreground">
              {roleFilter === 'all' ? 'All roles' : ROLE_DISPLAY[roleFilter] || roleFilter}
            </Text>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>
          {showRoleFilter && (
            <View className="absolute top-10 left-0 z-50 bg-background border border-border rounded-lg shadow-lg min-w-[140px]">
              {[{ value: 'all', label: 'All roles' }, { value: 'owner', label: 'Owner' }, { value: 'admin', label: 'Admin' }, { value: 'member', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }].map((opt) => (
                <Pressable
                  key={opt.value}
                  onPress={() => { setRoleFilter(opt.value); setShowRoleFilter(false) }}
                  className={cn(
                    'px-3 py-2',
                    roleFilter === opt.value && 'bg-accent'
                  )}
                >
                  <Text className={cn('text-sm', roleFilter === opt.value ? 'text-foreground font-medium' : 'text-foreground')}>
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <Pressable className="h-9 px-3 border border-border rounded-lg items-center justify-center">
          <Text className="text-sm text-foreground">Export</Text>
        </Pressable>

        <Pressable
          onPress={() => setShowInviteModal(true)}
          className="h-9 flex-row items-center gap-1.5 px-3 bg-primary rounded-lg"
        >
          <UserPlus size={14} className="text-primary-foreground" />
          <Text className="text-sm font-medium text-primary-foreground">Invite members</Text>
        </Pressable>
      </View>

      {/* Content based on sub-tab */}
      {subTab === 'all' && (
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground mt-2">Loading members...</Text>
              </View>
            ) : filteredMembers.length === 0 ? (
              <View className="py-12 items-center px-6">
                <Users size={32} className="text-muted-foreground/50 mb-3" />
                <Text className="text-sm text-muted-foreground">
                  {search.trim() || roleFilter !== 'all' ? 'No members match your filters' : 'No members yet. Invite someone to collaborate.'}
                </Text>
              </View>
            ) : (
              <>
                {/* Table header */}
                <View className="flex-row items-center px-4 py-2.5 border-b border-border bg-muted/30">
                  <Pressable onPress={() => handleSort('name')} className="flex-row items-center flex-[2]">
                    <Text className="text-xs font-medium text-muted-foreground">Name</Text>
                    <SortArrow field="name" />
                  </Pressable>
                  <Pressable onPress={() => handleSort('role')} className="flex-row items-center w-24">
                    <Text className="text-xs font-medium text-muted-foreground">Role</Text>
                    <SortArrow field="role" />
                  </Pressable>
                  <Pressable onPress={() => handleSort('joinedDate')} className="flex-row items-center w-28">
                    <Text className="text-xs font-medium text-muted-foreground">Joined date</Text>
                    <SortArrow field="joinedDate" />
                  </Pressable>
                  <View className="w-24">
                    <Text className="text-xs font-medium text-muted-foreground">{currentMonth} usage</Text>
                  </View>
                  <View className="w-24">
                    <Text className="text-xs font-medium text-muted-foreground">Total usage</Text>
                  </View>
                  <View className="w-24">
                    <Text className="text-xs font-medium text-muted-foreground">Credit limit</Text>
                  </View>
                  <View className="w-8" />
                </View>

                {/* Table rows */}
                {filteredMembers.map((member: any) => {
                  const isCurrentUser = member.userId === user?.id
                  const avatarColor = ROLE_COLORS[member.role] || 'bg-primary'
                  const mName = isCurrentUser ? (user?.name || user?.email) : (member.user?.name || member.user?.email || member.userId)
                  const mEmail = isCurrentUser ? user?.email : (member.user?.email || member.userId)
                  const initial = (mName || 'M')[0]?.toUpperCase()
                  return (
                    <View
                      key={member.id}
                      className="flex-row items-center px-4 py-3 border-b border-border"
                    >
                      <View className="flex-row items-center flex-[2] gap-3">
                        <View className={cn('h-8 w-8 rounded-full items-center justify-center', avatarColor)}>
                          <Text className="text-xs font-semibold text-white">{initial}</Text>
                        </View>
                        <View>
                          <View className="flex-row items-center gap-1">
                            <Text className="text-sm font-medium text-foreground">
                              {mName}
                            </Text>
                            {isCurrentUser && (
                              <Text className="text-sm text-muted-foreground">(you)</Text>
                            )}
                          </View>
                          <Text className="text-xs text-muted-foreground">
                            {mEmail}
                          </Text>
                        </View>
                      </View>

                      <View className="w-24">
                        <View className="flex-row items-center gap-1">
                          <Text className="text-sm text-foreground capitalize">
                            {ROLE_DISPLAY[member.role] || member.role}
                          </Text>
                          <ChevronDown size={12} className="text-muted-foreground" />
                        </View>
                      </View>

                      <View className="w-28">
                        <Text className="text-sm text-foreground">
                          {member.createdAt
                            ? new Date(member.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                            : '—'}
                        </Text>
                      </View>

                      <View className="w-24">
                        <Text className="text-sm text-foreground">0 credits</Text>
                      </View>

                      <View className="w-24">
                        <Text className="text-sm text-foreground">0 credits</Text>
                      </View>

                      <View className="w-24">
                        <Text className="text-sm text-foreground">—</Text>
                      </View>

                      <Pressable className="w-8 items-center">
                        <Text className="text-muted-foreground">···</Text>
                      </Pressable>
                    </View>
                  )
                })}

                {/* Footer */}
                <View className="px-4 py-2.5">
                  <Text className="text-xs text-muted-foreground">
                    Showing 1-{filteredMembers.length} of {filteredMembers.length}
                  </Text>
                </View>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {subTab === 'invitations' && (
        <View className="gap-4">
          {/* Received invitations */}
          <View>
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Received</Text>
            {receivedInvitations.length === 0 ? (
              <Card><CardContent className="py-6 items-center"><Text className="text-sm text-muted-foreground">No pending invitations</Text></CardContent></Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  {receivedInvitations.map((inv: any) => (
                    <View key={inv.id} className="p-4 border-b border-border">
                      <View className="flex-row items-center justify-between mb-1">
                        <Text className="text-base font-semibold text-foreground">{inv.workspace?.name || 'Workspace'}</Text>
                        <View className="px-2 py-0.5 rounded bg-muted"><Text className="text-xs text-muted-foreground capitalize">{ROLE_DISPLAY[inv.role] || inv.role}</Text></View>
                      </View>
                      <Text className="text-sm text-muted-foreground mb-3">You've been invited to join this workspace</Text>
                      <View className="flex-row gap-2">
                        <Pressable
                          onPress={async () => {
                            try {
                              await actions.acceptInvitation(inv.id, user?.id || '')
                            } catch {}
                          }}
                          className="flex-1 h-10 bg-primary rounded-lg items-center justify-center"
                        >
                          <Text className="text-sm font-medium text-primary-foreground">Accept</Text>
                        </Pressable>
                        <Pressable
                          onPress={async () => {
                            try {
                              await actions.declineInvitation(inv.id)
                            } catch {}
                          }}
                          className="flex-1 h-10 border border-border rounded-lg items-center justify-center"
                        >
                          <Text className="text-sm font-medium text-foreground">Decline</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </CardContent>
              </Card>
            )}
          </View>

          {/* Sent invitations */}
          <View>
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Sent</Text>
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground mt-2">Loading...</Text>
              </View>
            ) : pendingInvitations.length === 0 ? (
              <View className="py-16 items-center px-6">
                <View className="h-12 w-12 rounded-lg bg-muted/50 items-center justify-center mb-4">
                  <Mail size={24} className="text-muted-foreground/50" />
                </View>
                <Text className="text-base font-medium text-foreground mb-2">No invitations found</Text>
                <Pressable
                  onPress={() => setShowInviteModal(true)}
                  className="flex-row items-center gap-1.5 mt-2 px-4 py-2 border border-border rounded-lg"
                >
                  <UserPlus size={14} className="text-foreground" />
                  <Text className="text-sm font-medium text-foreground">Invite members</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {/* Table header */}
                <View className="flex-row items-center px-4 py-2.5 border-b border-border bg-muted/30">
                  <View className="flex-[2]">
                    <Text className="text-xs font-medium text-muted-foreground">Email</Text>
                  </View>
                  <View className="w-24">
                    <Text className="text-xs font-medium text-muted-foreground">Role</Text>
                  </View>
                  <View className="w-28">
                    <Text className="text-xs font-medium text-muted-foreground">Sent</Text>
                  </View>
                  <View className="w-24">
                    <Text className="text-xs font-medium text-muted-foreground">Status</Text>
                  </View>
                  <View className="w-8" />
                </View>

                {pendingInvitations.map((inv: any) => {
                  const isExpired = Date.now() > inv.expiresAt
                  return (
                    <View
                      key={inv.id}
                      className={cn('flex-row items-center px-4 py-3 border-b border-border', isExpired && 'opacity-60')}
                    >
                      <View className="flex-[2]">
                        <Text className={cn('text-sm text-foreground', isExpired && 'line-through')}>{inv.email}</Text>
                      </View>
                      <View className="w-24">
                        <Text className="text-sm text-foreground capitalize">{ROLE_DISPLAY[inv.role] || inv.role}</Text>
                      </View>
                      <View className="w-28">
                        <Text className="text-sm text-foreground">
                          {new Date(inv.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </Text>
                      </View>
                      <View className="w-24">
                        <Badge variant={isExpired ? 'destructive' : 'secondary'}>
                          <Text className="text-[10px]">{isExpired ? 'Expired' : 'Pending'}</Text>
                        </Badge>
                      </View>
                      <Pressable
                        onPress={() => handleCancelInvitation(inv.id)}
                        className="w-8 items-center"
                      >
                        <X size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                  )
                })}

                <View className="px-4 py-2.5">
                  <Text className="text-xs text-muted-foreground">
                    Showing 1-{pendingInvitations.length} of {pendingInvitations.length}
                  </Text>
                </View>
              </>
            )}
            {pendingInvitations.length === 0 && !isLoading && (
              <View className="px-4 py-2.5 border-t border-border">
                <Text className="text-xs text-muted-foreground">No results</Text>
              </View>
            )}
          </CardContent>
        </Card>
          </View>
        </View>
      )}

      {/* Invite Members Modal */}
      <InviteMembersModal
        visible={showInviteModal}
        onClose={() => {
          setShowInviteModal(false)
          loadPeopleData()
        }}
        workspaceId={resolvedWs?.id || currentWorkspace?.id || ''}
        workspaceName={resolvedWs?.name || currentWorkspace?.name || ''}
        actions={actions}
      />
    </View>
  )
}

function InviteMembersModal({
  visible,
  onClose,
  workspaceId,
  workspaceName,
  actions,
}: {
  visible: boolean
  onClose: () => void
  workspaceId: string
  workspaceName: string
  actions: ReturnType<typeof useDomainActions>
}) {
  const workspaces = useWorkspaceCollection()
  const [emailInput, setEmailInput] = useState('')
  const [role, setRole] = useState<string>('member')
  const [showRolePicker, setShowRolePicker] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const INVITE_ROLES = [
    { value: 'member', label: 'Editor' },
    { value: 'admin', label: 'Admin' },
    { value: 'viewer', label: 'Viewer' },
  ]

  const selectedRoleLabel = INVITE_ROLES.find((r) => r.value === role)?.label || 'Editor'

  const parseEmails = (input: string): string[] => {
    return input
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
  }

  const validEmails = parseEmails(emailInput)
  const canSubmit = validEmails.length > 0 && !isSubmitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    let resolvedWsId = workspaceId
    if (!resolvedWsId) {
      const ws = workspaces.all[0]
      resolvedWsId = ws?.id || ''
    }
    if (!resolvedWsId) {
      setError('Workspace not loaded yet. Please close and try again.')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      for (const email of validEmails) {
        await actions.sendInvitation({ email, role: role as any, workspaceId: resolvedWsId })
      }
      setEmailInput('')
      setRole('member')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setEmailInput('')
    setRole('member')
    setError(null)
    setShowRolePicker(false)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <Pressable
        onPress={handleClose}
        className="flex-1 bg-black/50 items-center justify-center px-6"
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="bg-background rounded-xl p-6 w-full max-w-md shadow-xl"
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-lg font-semibold text-foreground">Invite members</Text>
            <Pressable onPress={handleClose} className="p-1 -mr-1">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>

          <Text className="text-sm text-muted-foreground mb-5">
            Invite members to your workspace by email
          </Text>

          {error && (
            <View className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 mb-4">
              <Text className="text-destructive text-sm">{error}</Text>
            </View>
          )}

          <Text className="text-sm font-medium text-foreground mb-1.5">Email</Text>
          <View className="border border-border rounded-lg mb-4">
            <TextInput
              value={emailInput}
              onChangeText={(t) => { setEmailInput(t); setError(null) }}
              placeholder="example1@example.com, example2@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSubmitting}
              className="px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground web:outline-none"
            />
          </View>

          <Text className="text-sm font-medium text-foreground mb-1.5">Role</Text>
          <View className="relative mb-6">
            <Pressable
              onPress={() => setShowRolePicker(!showRolePicker)}
              className="flex-row items-center justify-between h-10 px-3 rounded-lg border border-border"
            >
              <Text className="text-sm text-foreground">{selectedRoleLabel}</Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
            {showRolePicker && (
              <View className="absolute top-11 left-0 right-0 z-50 bg-background border border-border rounded-lg shadow-lg">
                {INVITE_ROLES.map((r) => (
                  <Pressable
                    key={r.value}
                    onPress={() => { setRole(r.value); setShowRolePicker(false) }}
                    className={cn('px-3 py-2.5', role === r.value && 'bg-accent')}
                  >
                    <Text className={cn('text-sm', role === r.value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {r.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          <View className="flex-row gap-3">
            <Pressable
              onPress={handleClose}
              disabled={isSubmitting}
              className="flex-1 h-10 rounded-lg border border-border items-center justify-center"
            >
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'flex-1 h-10 rounded-lg items-center justify-center',
                canSubmit ? 'bg-primary' : 'bg-muted'
              )}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text className={cn('text-sm font-medium', canSubmit ? 'text-primary-foreground' : 'text-muted-foreground')}>
                  Invite
                </Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ============================================================================
// MAIN SETTINGS PAGE
// ============================================================================

function SettingsContent({ activeTab }: { activeTab: TabId }) {
  return (
    <>
      {activeTab === 'workspace' && <WorkspaceSettingsTab />}
      {activeTab === 'people' && <PeopleTab />}
      {activeTab === 'account' && <AccountTab />}
      {activeTab === 'billing' && <BillingTab />}
      {activeTab === 'labs' && <LabsTab />}
      {activeTab === 'github' && <GitHubTab />}
    </>
  )
}

export default observer(function SettingsPage() {
  const router = useRouter()
  const params = useLocalSearchParams<{ tab?: string }>()
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const { user } = useAuth()
  const workspaces = useWorkspaceCollection()
  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const [activeTab, setActiveTab] = useState<TabId>(
    () => (ALL_TAB_IDS.includes(params.tab as TabId) ? params.tab as TabId : 'workspace')
  )

  const workspaceName = currentWorkspace?.name || ''
  const userName = user?.name || ''

  if (isWide) {
    return (
      <View className="flex-1 bg-background flex-row">
        <SettingsSidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          workspaceName={workspaceName}
          userName={userName}
        />
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-12 pt-6 pb-[60px]"
          showsVerticalScrollIndicator={false}
        >
          <View>
            <View className="flex-row items-center justify-end mb-1">
              <Pressable
                onPress={() => Linking.openURL(DOCS_URL)}
                className="flex-row items-center gap-1.5"
              >
                <ExternalLink size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Docs</Text>
              </Pressable>
            </View>
            <SettingsContent activeTab={activeTab} />
          </View>
        </ScrollView>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/projects')}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-xl font-bold text-foreground">Settings</Text>
      </View>

      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 pb-10"
        showsVerticalScrollIndicator={false}
      >
        <SettingsContent activeTab={activeTab} />
      </ScrollView>
    </View>
  )
})
