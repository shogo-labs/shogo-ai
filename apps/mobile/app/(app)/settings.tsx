/**
 * Settings Page - Mobile (Expo)
 *
 * Comprehensive settings with tab-based navigation:
 * - Workspace: Name, avatar, danger zone
 * - Account: Profile, email, preferences
 * - Billing: Plan & credits
 * - Privacy: Visibility, security toggles
 * - Labs: Experimental features
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
} from 'react-native'
import { useRouter } from 'expo-router'
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
  Link as LinkIcon,
  BookOpen,
  MessageSquare,
} from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import {
  useDomain,
  useWorkspaceCollection,
  useMemberCollection,
  type IDomainStore,
} from '../../contexts/domain'
import { useDomainActions } from '@shogo/shared-app/domain'
import { useBillingData } from '@shogo/shared-app/hooks'
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

type TabId = 'workspace' | 'account' | 'billing' | 'privacy' | 'labs' | 'github'

interface NavItem {
  id: TabId
  label: string
  icon: React.ElementType
}

const NAV_ITEMS: NavItem[] = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'account', label: 'Account', icon: User },
  { id: 'billing', label: 'Plans & Credits', icon: CreditCard },
  { id: 'privacy', label: 'Privacy & Security', icon: Shield },
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
      contentContainerStyle={{ paddingHorizontal: 16 }}
    >
      {NAV_ITEMS.map((item) => {
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
  const isValid = name.trim().length > 0 && name.length <= 50

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
    <View className="gap-6">
      <View>
        <Text className="text-lg font-semibold text-foreground">
          Workspace settings
        </Text>
        <Text className="text-sm text-muted-foreground">
          Manage your workspace configuration.
        </Text>
      </View>

      <View className="gap-4">
        {/* Workspace avatar */}
        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-sm font-medium text-foreground">
                  Workspace avatar
                </Text>
                <Text className="text-xs text-muted-foreground">
                  Set an avatar for your workspace.
                </Text>
              </View>
              <View className="h-12 w-12 rounded-lg bg-primary/10 items-center justify-center">
                <Text className="text-lg font-medium text-primary">
                  {currentWorkspace?.name?.[0]?.toUpperCase() || 'W'}
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        {/* Workspace name */}
        <Card>
          <CardContent className="p-4 gap-3">
            <View>
              <Text className="text-sm font-medium text-foreground">
                Workspace name
              </Text>
              <Text className="text-xs text-muted-foreground">
                Your full workspace name, as visible to others.
              </Text>
            </View>
            <View className="flex-row gap-2 items-start">
              <View className="flex-1 gap-1">
                <Input
                  value={name}
                  onChangeText={(t) => {
                    setName(t)
                    setSaveStatus('idle')
                  }}
                />
                <Text className="text-xs text-muted-foreground">
                  {name.length} / 50 characters
                </Text>
              </View>
              <Button
                onPress={handleSave}
                disabled={!hasChanges || !isValid || isSaving}
                size="sm"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </View>
            {saveStatus === 'saved' && (
              <Text className="text-xs text-green-600">
                Changes saved successfully!
              </Text>
            )}
            {saveStatus === 'error' && (
              <Text className="text-xs text-destructive">
                Failed to save changes. Please try again.
              </Text>
            )}
          </CardContent>
        </Card>
      </View>

      <Separator />

      {/* Danger zone */}
      <View className="gap-4">
        <View>
          <Text className="text-sm font-medium text-destructive">
            Danger zone
          </Text>
          <Text className="text-xs text-muted-foreground">
            Irreversible and destructive actions.
          </Text>
        </View>

        <View className="p-4 rounded-lg border border-destructive/20 bg-destructive/5">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-medium text-foreground">
                Leave workspace
              </Text>
              <Text className="text-xs text-muted-foreground">
                Remove yourself from this workspace.
              </Text>
            </View>
            <Button variant="outline" size="sm" disabled>
              Leave
            </Button>
          </View>
        </View>

        {isOwner && (
          <View className="p-4 rounded-lg border border-destructive/20 bg-destructive/5">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-sm font-medium text-destructive">
                  Delete workspace
                </Text>
                <Text className="text-xs text-muted-foreground">
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
          </View>
        )}
      </View>

      {/* Delete Workspace Confirmation Modal */}
      <Modal
        visible={isDeleteDialogOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsDeleteDialogOpen(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => setIsDeleteDialogOpen(false)}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4">
            <Text className="text-lg font-semibold text-destructive">
              Delete workspace
            </Text>
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

function AccountTab() {
  const { user, signOut } = useAuth()
  const router = useRouter()

  const PROFILE_KEY = 'shogo:account-profile'
  const PREFS_KEY = 'shogo:account-prefs'

  const [name, setName] = useState(user?.name || '')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [link, setLink] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [chatSuggestions, setChatSuggestions] = useState(true)

  const originalName = user?.name || ''
  const hasNameChanges = name !== originalName
  const hasChanges = hasNameChanges

  useEffect(() => {
    setName(user?.name || '')
  }, [user?.name])

  const handleSave = async () => {
    if (!hasChanges || isSaving || !user?.id) return
    if (hasNameChanges && !name.trim()) return
    setIsSaving(true)
    setSaveStatus('idle')
    try {
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

  return (
    <View className="gap-6">
      <View>
        <Text className="text-lg font-semibold text-foreground">
          Account settings
        </Text>
        <Text className="text-sm text-muted-foreground">
          Personalize how others see and interact with you on Shogo.
        </Text>
      </View>

      {/* Activity heatmap placeholder */}
      <Card>
        <CardContent className="p-4 gap-3">
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

      {/* Profile settings */}
      <View className="gap-4">
        {/* Avatar */}
        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-sm font-medium text-foreground">
                  Your avatar
                </Text>
                <Text className="text-xs text-muted-foreground">
                  Your avatar is fetched from your identity provider or
                  automatically generated.
                </Text>
              </View>
              <View className="h-12 w-12 rounded-full bg-primary/10 items-center justify-center">
                <Text className="text-lg font-medium text-primary">
                  {user?.name?.[0]?.toUpperCase() || 'U'}
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        {/* Username */}
        <Card>
          <CardContent className="p-4 gap-2">
            <View>
              <Text className="text-sm font-medium text-foreground">
                Username
              </Text>
              <Text className="text-xs text-muted-foreground">
                Your public identifier and profile URL.
              </Text>
            </View>
            <View className="flex-row gap-2">
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
              <Text className="text-xs text-green-600">
                Name updated successfully!
              </Text>
            )}
            {saveStatus === 'error' && (
              <Text className="text-xs text-destructive">
                Failed to update. Please try again.
              </Text>
            )}
          </CardContent>
        </Card>

        {/* Email */}
        <Card>
          <CardContent className="p-4 gap-2">
            <View>
              <Text className="text-sm font-medium text-foreground">Email</Text>
              <Text className="text-xs text-muted-foreground">
                Your email address associated with your account.
              </Text>
            </View>
            <Input value={user?.email || ''} disabled />
          </CardContent>
        </Card>

        {/* Name */}
        <Card>
          <CardContent className="p-4 gap-2">
            <View>
              <Text className="text-sm font-medium text-foreground">Name</Text>
              <Text className="text-xs text-muted-foreground">
                Your full name, as visible to others.
              </Text>
            </View>
            <Input
              value={name}
              onChangeText={(t) => {
                setName(t)
                setSaveStatus('idle')
              }}
              placeholder="Enter your name"
            />
          </CardContent>
        </Card>

        {/* Description */}
        <Card>
          <CardContent className="p-4 gap-2">
            <View>
              <Text className="text-sm font-medium text-foreground">
                Description
              </Text>
              <Text className="text-xs text-muted-foreground">
                A short description of yourself or your work.
              </Text>
            </View>
            <Input
              value={description}
              onChangeText={setDescription}
              placeholder="Tell us about yourself..."
              multiline
              numberOfLines={3}
            />
          </CardContent>
        </Card>

        {/* Location */}
        <Card>
          <CardContent className="p-4 gap-2">
            <View>
              <Text className="text-sm font-medium text-foreground">
                Location
              </Text>
              <Text className="text-xs text-muted-foreground">
                Where you're based.
              </Text>
            </View>
            <Input
              value={location}
              onChangeText={setLocation}
              placeholder="San Francisco, CA"
            />
          </CardContent>
        </Card>

        {/* Link */}
        <Card>
          <CardContent className="p-4 gap-2">
            <View>
              <Text className="text-sm font-medium text-foreground">Link</Text>
              <Text className="text-xs text-muted-foreground">
                Add a link to your personal website or portfolio.
              </Text>
            </View>
            <Input
              value={link}
              onChangeText={setLink}
              placeholder="https://your-website.com"
              keyboardType="url"
              autoCapitalize="none"
            />
          </CardContent>
        </Card>
      </View>

      {/* Preferences */}
      <View className="gap-4">
        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-sm font-medium text-foreground">
                  Chat suggestions
                </Text>
                <Text className="text-xs text-muted-foreground">
                  Show helpful suggestions in the chat interface.
                </Text>
              </View>
              <Switch
                checked={chatSuggestions}
                onCheckedChange={setChatSuggestions}
              />
            </View>
          </CardContent>
        </Card>
      </View>

      {/* Linked accounts */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View>
            <Text className="text-sm font-medium text-foreground">
              Linked accounts
            </Text>
            <Text className="text-xs text-muted-foreground">
              Manage accounts linked for sign-in.
            </Text>
          </View>
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
            <Button variant="outline" size="sm">
              Link
            </Button>
          </View>
        </CardContent>
      </Card>

      {/* Two-factor authentication */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View>
            <Text className="text-sm font-medium text-foreground">
              Two-factor authentication
            </Text>
            <Text className="text-xs text-muted-foreground">
              Secure your account with a one-time code via an authenticator app
              or SMS.
            </Text>
          </View>
          <View className="bg-muted/50 rounded-lg p-3 flex-row items-center gap-3">
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
            <Button variant="outline" size="sm">
              Verify
            </Button>
          </View>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <View className="gap-4">
        <View className="p-4 rounded-lg border border-destructive/20 bg-destructive/5 flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-medium text-destructive">
              Delete account
            </Text>
            <Text className="text-xs text-muted-foreground">
              Permanently delete your Shogo account. This cannot be undone.
            </Text>
          </View>
          <Button variant="destructive" size="sm">
            Delete
          </Button>
        </View>
      </View>

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
// BILLING TAB
// ============================================================================

const PLAN_CREDITS: Record<string, number> = {
  free: 0,
  starter: 50,
  pro: 200,
  team: 500,
  enterprise: 2000,
}

const DAILY_CREDITS: Record<string, number> = {
  free: 5,
  starter: 10,
  pro: 25,
  team: 50,
  enterprise: 100,
}

function getTotalCreditsForPlan(
  planId: string | undefined,
  planCredits: Record<string, number>,
  dailyCredits: Record<string, number>
): number {
  if (!planId) return (planCredits['free'] || 0) + (dailyCredits['free'] || 0)
  return (planCredits[planId] || 0) + (dailyCredits[planId] || 0)
}

function formatCredits(n: number): string {
  return n % 1 === 0 ? n.toString() : n.toFixed(1)
}

function BillingTab() {
  const workspaces = useWorkspaceCollection()
  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const {
    subscription,
    effectiveBalance,
    hasActiveSubscription,
    isLoading: isBillingLoading,
  } = useBillingData(currentWorkspace?.id)

  const planType = subscription
    ? subscription.planId.charAt(0).toUpperCase() + subscription.planId.slice(1)
    : 'Free'

  const creditsTotal = getTotalCreditsForPlan(
    subscription?.planId,
    PLAN_CREDITS,
    DAILY_CREDITS
  )
  const creditsRemaining = effectiveBalance?.total ?? creditsTotal

  if (isBillingLoading) {
    return (
      <View className="items-center justify-center py-20">
        <ActivityIndicator />
        <Text className="mt-2 text-sm text-muted-foreground">
          Loading billing...
        </Text>
      </View>
    )
  }

  return (
    <View className="gap-6">
      <View>
        <Text className="text-lg font-semibold text-foreground">
          Plans & credits
        </Text>
        <Text className="text-sm text-muted-foreground">
          Manage your subscription plan and credit balance.
        </Text>
      </View>

      {/* Current plan */}
      <Card>
        <CardContent className="p-4">
          <View className="flex-row items-center gap-3">
            <View className="h-12 w-12 rounded-lg bg-primary/10 items-center justify-center">
              <Sparkles size={24} className="text-primary" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">
                You're on {planType} Plan
              </Text>
              <Text className="text-xs text-muted-foreground">
                {subscription ? 'Manage your subscription' : 'Upgrade anytime'}
              </Text>
            </View>
          </View>
        </CardContent>
      </Card>

      {/* Credits */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row justify-between">
            <Text className="text-sm text-muted-foreground">
              Credits remaining
            </Text>
            <Text className="text-sm font-medium text-foreground">
              {formatCredits(creditsRemaining)} of {creditsTotal}
            </Text>
          </View>
          <Progress
            value={(creditsRemaining / Math.max(creditsTotal, 1)) * 100}
            className="h-2"
          />
          {effectiveBalance && (
            <Text className="text-xs text-muted-foreground">
              Daily: {formatCredits(effectiveBalance.dailyCredits)} · Monthly:{' '}
              {formatCredits(effectiveBalance.monthlyCredits)}
            </Text>
          )}
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              {subscription ? (
                <>
                  <Check size={12} className="text-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    Credits rollover to next month
                  </Text>
                </>
              ) : (
                <Text className="text-xs text-muted-foreground">
                  × No credits will rollover
                </Text>
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

      {/* Plan cards */}
      {(['starter', 'pro', 'team'] as const).map((planId) => {
        const isCurrentPlan = subscription?.planId === planId
        return (
          <Card
            key={planId}
            className={isCurrentPlan ? 'border-primary' : undefined}
          >
            <CardContent className="p-4 gap-2">
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-semibold text-foreground capitalize">
                  {planId}
                </Text>
                {isCurrentPlan && <Badge>Current</Badge>}
              </View>
              <Text className="text-sm text-muted-foreground">
                {PLAN_CREDITS[planId]} monthly + {DAILY_CREDITS[planId]} daily
                credits
              </Text>
              {!isCurrentPlan && (
                <Button variant="outline" size="sm" className="mt-2">
                  {subscription ? 'Switch Plan' : 'Upgrade'}
                </Button>
              )}
            </CardContent>
          </Card>
        )
      })}
    </View>
  )
}

// ============================================================================
// PRIVACY & SECURITY TAB
// ============================================================================

function PrivacyTab() {
  const [mcpServers, setMcpServers] = useState(false)
  const [dataOptOut, setDataOptOut] = useState(false)
  const [restrictInvites, setRestrictInvites] = useState(false)

  return (
    <View className="gap-6">
      <View>
        <Text className="text-lg font-semibold text-foreground">
          Privacy & security
        </Text>
        <Text className="text-sm text-muted-foreground">
          Manage privacy and security settings for your workspace.
        </Text>
      </View>

      <View className="gap-4">
        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-medium text-foreground">
                    MCP servers access
                  </Text>
                  <Badge className="bg-purple-500/10">
                    <Text className="text-[10px] text-purple-500">Business</Text>
                  </Badge>
                </View>
                <Text className="text-xs text-muted-foreground mt-1">
                  Enable or disable MCP servers for all workspace members.
                </Text>
              </View>
              <Switch checked={mcpServers} onCheckedChange={setMcpServers} />
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-medium text-foreground">
                    Data collection opt out
                  </Text>
                  <Badge className="bg-purple-500/10">
                    <Text className="text-[10px] text-purple-500">Business</Text>
                  </Badge>
                </View>
                <Text className="text-xs text-muted-foreground mt-1">
                  Opt out of data collection for this workspace.
                </Text>
              </View>
              <Switch checked={dataOptOut} onCheckedChange={setDataOptOut} />
            </View>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-medium text-foreground">
                    Restrict workspace invitations
                  </Text>
                  <Badge className="bg-amber-500/10">
                    <Text className="text-[10px] text-amber-500">
                      Enterprise
                    </Text>
                  </Badge>
                </View>
                <Text className="text-xs text-muted-foreground mt-1">
                  When enabled, only admins and owners can invite members.
                </Text>
              </View>
              <Switch
                checked={restrictInvites}
                onCheckedChange={setRestrictInvites}
              />
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

function LabsTab() {
  const [githubBranchSwitching, setGithubBranchSwitching] = useState(false)

  return (
    <View className="gap-6">
      <View className="flex-row items-start justify-between">
        <View className="flex-1">
          <Text className="text-lg font-semibold text-foreground">Labs</Text>
          <Text className="text-sm text-muted-foreground">
            These are experimental features that might be modified or removed.
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          onPress={() => Linking.openURL(DOCS_URL)}
        >
          Docs
        </Button>
      </View>

      <Card>
        <CardContent className="p-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-medium text-foreground">
                GitHub branch switching
              </Text>
              <Text className="text-xs text-muted-foreground">
                Select the branch to make edits to in your GitHub repository.
              </Text>
            </View>
            <Switch
              checked={githubBranchSwitching}
              onCheckedChange={setGithubBranchSwitching}
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
  return (
    <View className="gap-6">
      <View className="flex-row items-start justify-between">
        <View className="flex-1">
          <Text className="text-lg font-semibold text-foreground">GitHub</Text>
          <Text className="text-sm text-muted-foreground">
            Sync your project 2-way with GitHub to collaborate at source.
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          onPress={() => Linking.openURL(DOCS_URL)}
        >
          Docs
        </Button>
      </View>

      <Card>
        <CardContent className="p-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-medium text-foreground">
                  Connected account
                </Text>
                <Badge variant="secondary">
                  <Text className="text-[10px] text-secondary-foreground">
                    admin
                  </Text>
                </Badge>
              </View>
              <Text className="text-xs text-muted-foreground mt-1">
                Add your GitHub account to manage connected organizations.
              </Text>
            </View>
            <Button variant="outline" size="sm">
              Connect
            </Button>
          </View>
        </CardContent>
      </Card>
    </View>
  )
}

// ============================================================================
// MAIN SETTINGS PAGE
// ============================================================================

export default observer(function SettingsPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabId>('workspace')

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-xl font-bold text-foreground">Settings</Text>
      </View>

      {/* Tab navigation */}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Content */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {activeTab === 'workspace' && <WorkspaceSettingsTab />}
        {activeTab === 'account' && <AccountTab />}
        {activeTab === 'billing' && <BillingTab />}
        {activeTab === 'privacy' && <PrivacyTab />}
        {activeTab === 'labs' && <LabsTab />}
        {activeTab === 'github' && <GitHubTab />}
      </ScrollView>
    </View>
  )
})
