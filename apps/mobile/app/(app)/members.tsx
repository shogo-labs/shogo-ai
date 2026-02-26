import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  Modal,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Users,
  UserPlus,
  Mail,
  Loader2,
  Trash2,
  UserCircle,
  X,
  Clock,
  AlertCircle,
  Building2,
  Check,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useWorkspaceCollection,
  useMemberCollection,
  useInvitationCollection,
  useDomainActions,
} from '../../contexts/domain'

type TabId = 'members' | 'pending' | 'my-invitations'

interface Member {
  id: string
  userId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  createdAt: number
  updatedAt?: number
}

interface Invitation {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  status: string
  expiresAt: number
  createdAt: number
  workspaceId?: string
  workspace?: { id: string; name: string }
}

const ROLE_LEVELS: Record<string, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
}

const AVAILABLE_INVITE_ROLES = ['admin', 'member', 'viewer'] as const

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = timestamp - now
  const absDiff = Math.abs(diff)

  const minutes = Math.floor(absDiff / (1000 * 60))
  const hours = Math.floor(absDiff / (1000 * 60 * 60))
  const days = Math.floor(absDiff / (1000 * 60 * 60 * 24))

  if (diff > 0) {
    if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`
    if (hours > 0) return `in ${hours} hour${hours === 1 ? '' : 's'}`
    if (minutes > 0) return `in ${minutes} min${minutes === 1 ? '' : 's'}`
    return 'soon'
  } else {
    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return 'just now'
  }
}

function isValidEmail(email: string): boolean {
  if (!email || email.trim().length === 0) return false
  const parts = email.split('@')
  if (parts.length !== 2) return false
  const [localPart, domainPart] = parts
  if (!localPart || !domainPart) return false
  if (!domainPart.includes('.')) return false
  const tld = domainPart.split('.').pop()
  if (!tld || tld.length < 2) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// --- Tab Bar ---
function TabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
}) {
  const tabs: { id: TabId; label: string; icon: typeof Users }[] = [
    { id: 'members', label: 'Members', icon: Users },
    { id: 'pending', label: 'Pending', icon: Mail },
    { id: 'my-invitations', label: 'My Invites', icon: UserPlus },
  ]

  return (
    <View className="flex-row border-b border-border mx-4">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const active = activeTab === tab.id
        return (
          <Pressable
            key={tab.id}
            onPress={() => onTabChange(tab.id)}
            className={cn(
              'flex-1 flex-row items-center justify-center gap-1.5 py-3',
              active && 'border-b-2 border-primary'
            )}
          >
            <Icon
              size={16}
              className={active ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text
              className={cn(
                'text-sm font-medium',
                active ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// --- Member Row ---
function MemberRow({
  member,
  isCurrentUser,
  canManage,
  onChangeRole,
  onRemove,
}: {
  member: Member
  isCurrentUser: boolean
  canManage: boolean
  onChangeRole: () => void
  onRemove: () => void
}) {
  return (
    <View
      className={cn(
        'flex-row items-center px-4 py-3 border-b border-border',
        isCurrentUser && 'bg-primary/5'
      )}
    >
      <UserCircle size={32} className="text-muted-foreground" />
      <View className="flex-1 ml-3">
        <View className="flex-row items-center">
          <Text className="text-foreground font-medium text-sm" numberOfLines={1}>
            {member.userId.slice(0, 16)}...
          </Text>
          {isCurrentUser && (
            <Text className="text-muted-foreground text-xs ml-2">(you)</Text>
          )}
        </View>
        <Text className="text-muted-foreground text-xs mt-0.5">
          Joined {new Date(member.createdAt).toLocaleDateString()}
        </Text>
      </View>

      <Pressable
        onPress={canManage ? onChangeRole : undefined}
        className={cn(
          'px-2.5 py-1 rounded-full mr-2',
          member.role === 'owner'
            ? 'bg-primary'
            : member.role === 'admin'
              ? 'bg-secondary'
              : 'border border-border'
        )}
      >
        <Text
          className={cn(
            'text-xs font-medium capitalize',
            member.role === 'owner'
              ? 'text-primary-foreground'
              : member.role === 'admin'
                ? 'text-secondary-foreground'
                : 'text-foreground'
          )}
        >
          {member.role}
        </Text>
      </Pressable>

      {canManage && (
        <Pressable onPress={onRemove} className="p-2">
          <Trash2 size={16} className="text-destructive" />
        </Pressable>
      )}
    </View>
  )
}

// --- Invite Modal ---
function InviteModal({
  visible,
  onClose,
  workspaceId,
  actions,
  currentUserId,
  invitationCollection,
}: {
  visible: boolean
  onClose: () => void
  workspaceId: string
  actions: ReturnType<typeof useDomainActions>
  currentUserId: string
  invitationCollection: any
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>('member')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!isValidEmail(email)) {
      setError('Please enter a valid email address')
      return
    }
    setIsSubmitting(true)
    setError(null)
    try {
      await invitationCollection.loadAll({ workspaceId })
      const existing = invitationCollection.all.find(
        (i: any) => i.email === email && i.status === 'pending' && i.workspaceId === workspaceId
      )
      if (existing) {
        throw new Error('Invitation already pending for this email')
      }
      await actions.sendInvitation({ email, role: role as any, workspaceId })
      setEmail('')
      setRole('member')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setEmail('')
    setRole('member')
    setError(null)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <Pressable onPress={handleClose} className="flex-1 bg-black/50 justify-end">
          <Pressable onPress={() => {}} className="bg-background rounded-t-2xl p-6">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-foreground text-lg font-semibold">Invite Member</Text>
              <Pressable onPress={handleClose} className="p-1">
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>

            <Text className="text-muted-foreground text-sm mb-4">
              Send an invitation to a new team member.
            </Text>

            {error && (
              <View className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 mb-4">
                <Text className="text-destructive text-sm">{error}</Text>
              </View>
            )}

            <Text className="text-foreground text-sm font-medium mb-1.5">Email</Text>
            <View className="flex-row items-center border border-border rounded-lg px-3 py-2.5 mb-4">
              <Mail size={16} className="text-muted-foreground mr-2" />
              <TextInput
                value={email}
                onChangeText={(t) => { setEmail(t); setError(null) }}
                placeholder="colleague@example.com"
                placeholderTextColor="#9ca3af"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSubmitting}
                className="flex-1 text-foreground text-sm"
              />
            </View>

            <Text className="text-foreground text-sm font-medium mb-1.5">Role</Text>
            <View className="flex-row gap-2 mb-2">
              {AVAILABLE_INVITE_ROLES.map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setRole(r)}
                  className={cn(
                    'flex-1 py-2.5 rounded-lg border items-center',
                    role === r
                      ? 'border-primary bg-primary/10'
                      : 'border-border'
                  )}
                >
                  <Text
                    className={cn(
                      'text-sm font-medium capitalize',
                      role === r ? 'text-primary' : 'text-foreground'
                    )}
                  >
                    {r}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text className="text-muted-foreground text-xs mb-6">
              {role === 'admin' && 'Admins can manage members and settings'}
              {role === 'member' && 'Members can create and edit content'}
              {role === 'viewer' && 'Viewers have read-only access'}
            </Text>

            <View className="flex-row gap-3">
              <Pressable
                onPress={handleClose}
                disabled={isSubmitting}
                className="flex-1 border border-border rounded-lg py-3 items-center"
              >
                <Text className="text-foreground font-medium">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleSubmit}
                disabled={!isValidEmail(email) || isSubmitting}
                className={cn(
                  'flex-1 rounded-lg py-3 items-center',
                  isValidEmail(email) && !isSubmitting ? 'bg-primary' : 'bg-muted'
                )}
              >
                {isSubmitting ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <Text
                    className={cn(
                      'font-medium',
                      isValidEmail(email) ? 'text-primary-foreground' : 'text-muted-foreground'
                    )}
                  >
                    Send Invitation
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

// --- Members Tab Content ---
function MembersTab({
  orgId,
  currentUserId,
  currentUserRole,
}: {
  orgId: string
  currentUserId: string
  currentUserRole: string
}) {
  const members = useMemberCollection()
  const actions = useDomainActions()
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const currentUserLevel = ROLE_LEVELS[currentUserRole] ?? 0
  const canManageMembers = currentUserLevel >= ROLE_LEVELS.admin

  const loadMembers = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      await members.loadAll({ workspaceId: orgId })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    } finally {
      setIsLoading(false)
    }
  }, [orgId, members])

  useEffect(() => { loadMembers() }, [loadMembers])

  const orgMembers: Member[] = useMemo(() =>
    members.all
      .filter((m: any) => m.workspaceId === orgId)
      .map((m: any) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    [members.all, orgId]
  )

  const canManageMember = (member: Member): boolean => {
    if (member.userId === currentUserId) return false
    return currentUserLevel > (ROLE_LEVELS[member.role] ?? 0)
  }

  const getAvailableRoles = (member: Member): string[] => {
    if (member.role === 'owner' && currentUserRole !== 'owner') return []
    return Object.keys(ROLE_LEVELS).filter((role) => {
      if (role === 'owner' && currentUserRole !== 'owner') return false
      return ROLE_LEVELS[role] <= currentUserLevel
    })
  }

  const [roleChangeModal, setRoleChangeModal] = useState<{ member: Member; roles: string[] } | null>(null)
  const [removeModal, setRemoveModal] = useState<Member | null>(null)

  const handleChangeRole = (member: Member) => {
    const roles = getAvailableRoles(member)
    setRoleChangeModal({ member, roles })
  }

  const handleRemove = (member: Member) => {
    setRemoveModal(member)
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center py-8">
        <ActivityIndicator size="small" />
        <Text className="text-muted-foreground ml-2 mt-2">Loading members...</Text>
      </View>
    )
  }

  if (error) {
    return (
      <View className="m-4 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
        <Text className="text-destructive text-sm">{error}</Text>
      </View>
    )
  }

  if (orgMembers.length === 0) {
    return (
      <View className="items-center justify-center py-12">
        <Text className="text-muted-foreground">No members found</Text>
      </View>
    )
  }

  return (
    <>
      <FlatList
        data={orgMembers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MemberRow
            member={item}
            isCurrentUser={item.userId === currentUserId}
            canManage={canManageMembers && canManageMember(item)}
            onChangeRole={() => handleChangeRole(item)}
            onRemove={() => handleRemove(item)}
          />
        )}
      />

      {/* Role Change Modal */}
      <Modal
        visible={!!roleChangeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setRoleChangeModal(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-end"
          onPress={() => setRoleChangeModal(null)}
        >
          <View className="bg-background rounded-t-2xl p-4 pb-8">
            <Text className="text-foreground text-lg font-semibold mb-3">Change Role</Text>
            {roleChangeModal?.roles.map((role) => (
              <Pressable
                key={role}
                onPress={async () => {
                  try {
                    await actions.updateMemberRole(roleChangeModal.member.id, role as any, currentUserId)
                    loadMembers()
                  } catch {
                    Alert.alert('Error', 'Failed to update role')
                  }
                  setRoleChangeModal(null)
                }}
                className={cn(
                  'py-3 px-4 rounded-lg mb-1',
                  roleChangeModal.member.role === role && 'bg-primary/10'
                )}
              >
                <Text className={cn(
                  'text-sm capitalize',
                  roleChangeModal.member.role === role ? 'text-primary font-medium' : 'text-foreground'
                )}>
                  {role}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setRoleChangeModal(null)}
              className="py-3 px-4 rounded-lg mt-1"
            >
              <Text className="text-sm text-muted-foreground">Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Remove Member Modal */}
      <Modal
        visible={!!removeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setRemoveModal(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center px-6"
          onPress={() => setRemoveModal(null)}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4" onPress={(e) => e.stopPropagation()}>
            <Text className="text-lg font-semibold text-foreground">Remove Member</Text>
            <Text className="text-sm text-muted-foreground">
              Are you sure you want to remove this member? This action cannot be undone.
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setRemoveModal(null)}
                className="px-4 py-2 rounded-md border border-border"
              >
                <Text className="text-sm text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  if (!removeModal) return
                  try {
                    await actions.removeMember(removeModal.id, currentUserId)
                    loadMembers()
                  } catch {
                    Alert.alert('Error', 'Failed to remove member')
                  }
                  setRemoveModal(null)
                }}
                className="px-4 py-2 rounded-md bg-destructive"
              >
                <Text className="text-sm text-destructive-foreground">Remove</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

// --- Pending Invitations Tab Content ---
function PendingTab({ orgId }: { orgId: string }) {
  const invitations = useInvitationCollection()
  const actions = useDomainActions()
  const [isLoading, setIsLoading] = useState(true)

  const loadInvitations = useCallback(async () => {
    setIsLoading(true)
    try {
      await invitations.loadAll({ workspaceId: orgId })
    } catch {
      // non-critical
    } finally {
      setIsLoading(false)
    }
  }, [orgId, invitations])

  useEffect(() => { loadInvitations() }, [loadInvitations])

  const pending: Invitation[] = useMemo(() =>
    invitations.all
      .filter((i: any) => i.workspaceId === orgId && i.status === 'pending')
      .map((i: any) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    [invitations.all, orgId]
  )

  const [cancelModal, setCancelModal] = useState<Invitation | null>(null)

  const handleCancel = (inv: Invitation) => {
    setCancelModal(inv)
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center py-8">
        <ActivityIndicator size="small" />
        <Text className="text-muted-foreground mt-2">Loading invitations...</Text>
      </View>
    )
  }

  if (pending.length === 0) {
    return (
      <View className="items-center justify-center py-12">
        <Clock size={32} className="text-muted-foreground/50 mb-2" />
        <Text className="text-muted-foreground">No pending invitations</Text>
        <Text className="text-muted-foreground text-sm mt-1">
          Invite team members to get started
        </Text>
      </View>
    )
  }

  return (
    <>
      <FlatList
        data={pending}
        keyExtractor={(item) => item.id}
        contentContainerClassName="p-4 gap-3"
        renderItem={({ item }) => {
          const isExpired = Date.now() > item.expiresAt
          return (
            <View
              className={cn(
                'p-4 rounded-lg border border-border',
                isExpired ? 'bg-muted/50 opacity-75' : 'bg-card'
              )}
            >
              <View className="flex-row items-center justify-between">
                <View className="flex-1 mr-3">
                  <View className="flex-row items-center gap-2 flex-wrap">
                    <Text
                      className={cn(
                        'text-foreground font-medium',
                        isExpired && 'line-through text-muted-foreground'
                      )}
                    >
                      {item.email}
                    </Text>
                    <View className="bg-secondary px-2 py-0.5 rounded-full">
                      <Text className="text-secondary-foreground text-xs capitalize">
                        {item.role}
                      </Text>
                    </View>
                    {isExpired && (
                      <View className="bg-destructive px-2 py-0.5 rounded-full">
                        <Text className="text-destructive-foreground text-xs">Expired</Text>
                      </View>
                    )}
                  </View>
                  <Text className="text-muted-foreground text-sm mt-1">
                    Sent {formatRelativeTime(item.createdAt)}
                    {!isExpired && ` · Expires ${formatRelativeTime(item.expiresAt)}`}
                  </Text>
                </View>
                <Pressable
                  onPress={() => handleCancel(item)}
                  className="flex-row items-center px-3 py-1.5 rounded-lg border border-border active:bg-muted"
                >
                  <X size={14} className="text-muted-foreground mr-1" />
                  <Text className="text-muted-foreground text-sm">Cancel</Text>
                </Pressable>
              </View>
            </View>
          )
        }}
      />

      {/* Cancel Invitation Modal */}
      <Modal
        visible={!!cancelModal}
        transparent
        animationType="fade"
        onRequestClose={() => setCancelModal(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 items-center justify-center px-6"
          onPress={() => setCancelModal(null)}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4" onPress={(e) => e.stopPropagation()}>
            <Text className="text-lg font-semibold text-foreground">Cancel Invitation</Text>
            <Text className="text-sm text-muted-foreground">
              Cancel the invitation for {cancelModal?.email}?
            </Text>
            <View className="flex-row gap-2 justify-end">
              <Pressable
                onPress={() => setCancelModal(null)}
                className="px-4 py-2 rounded-md border border-border"
              >
                <Text className="text-sm text-foreground">Keep</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  if (!cancelModal) return
                  try {
                    await actions.cancelInvitation(cancelModal.id)
                    loadInvitations()
                  } catch {
                    Alert.alert('Error', 'Failed to cancel invitation')
                  }
                  setCancelModal(null)
                }}
                className="px-4 py-2 rounded-md bg-destructive"
              >
                <Text className="text-sm text-destructive-foreground">Cancel Invitation</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

// --- My Invitations Tab Content ---
function MyInvitationsTab() {
  const { user } = useAuth()
  const invitations = useInvitationCollection()
  const workspaces = useWorkspaceCollection()
  const actions = useDomainActions()
  const [isLoading, setIsLoading] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)

  const loadInvitations = useCallback(async () => {
    if (!user?.email) return
    setIsLoading(true)
    try {
      await invitations.loadAll({ email: user.email })
      await workspaces.loadAll({})
    } catch {
      // non-critical
    } finally {
      setIsLoading(false)
    }
  }, [user?.email, invitations, workspaces])

  useEffect(() => { loadInvitations() }, [loadInvitations])

  const myPending: Invitation[] = useMemo(() =>
    invitations.all
      .filter((i: any) => i.email === user?.email && i.status === 'pending')
      .map((i: any) => {
        const ws = i.workspaceId ? workspaces.all.find((w: any) => w.id === i.workspaceId) : null
        return {
          id: i.id,
          email: i.email,
          role: i.role,
          status: i.status,
          expiresAt: i.expiresAt,
          createdAt: i.createdAt,
          workspaceId: i.workspaceId,
          workspace: ws ? { id: ws.id, name: ws.name } : undefined,
        }
      }),
    [invitations.all, workspaces.all, user?.email]
  )

  const handleAccept = async (inv: Invitation) => {
    if (!user?.id) return
    setProcessingId(inv.id)
    try {
      await actions.acceptInvitation(inv.id, user.id)
      loadInvitations()
    } catch {
      Alert.alert('Error', 'Failed to accept invitation')
    } finally {
      setProcessingId(null)
    }
  }

  const handleDecline = async (inv: Invitation) => {
    if (!user?.id) return
    setProcessingId(inv.id)
    try {
      await actions.declineInvitation(inv.id)
      loadInvitations()
    } catch {
      Alert.alert('Error', 'Failed to decline invitation')
    } finally {
      setProcessingId(null)
    }
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center py-8">
        <ActivityIndicator size="small" />
        <Text className="text-muted-foreground mt-2">Loading invitations...</Text>
      </View>
    )
  }

  if (myPending.length === 0) {
    return (
      <View className="items-center justify-center py-12">
        <Building2 size={32} className="text-muted-foreground/50 mb-2" />
        <Text className="text-muted-foreground">No pending invitations</Text>
        <Text className="text-muted-foreground text-sm mt-1">
          You don't have any pending invitations
        </Text>
      </View>
    )
  }

  return (
    <FlatList
      data={myPending}
      keyExtractor={(item) => item.id}
      contentContainerClassName="p-4 gap-4"
      renderItem={({ item }) => {
        const isExpired = Date.now() > item.expiresAt
        const isProcessing = processingId === item.id
        const timeRemaining = isExpired
          ? 'Expired'
          : formatRelativeTime(item.expiresAt)

        return (
          <View className={cn('p-4 rounded-lg border border-border bg-card', isExpired && 'opacity-75')}>
            <View className="flex-row items-start justify-between">
              <View className="flex-row items-center gap-2">
                <Building2 size={20} className="text-muted-foreground" />
                <Text className="text-foreground font-semibold text-lg">
                  {item.workspace?.name || 'Unknown'}
                </Text>
              </View>
              <View className="bg-secondary px-2 py-0.5 rounded-full">
                <Text className="text-secondary-foreground text-xs capitalize">{item.role}</Text>
              </View>
            </View>

            <Text className="text-muted-foreground text-sm mt-1">
              You've been invited to join this workspace
            </Text>

            <View className="flex-row items-center gap-2 mt-3">
              <Clock size={14} className="text-muted-foreground" />
              <Text className={cn('text-sm', isExpired ? 'text-destructive' : 'text-muted-foreground')}>
                {timeRemaining}
              </Text>
            </View>

            <View className="flex-row gap-3 mt-4">
              <Pressable
                onPress={() => handleAccept(item)}
                disabled={isExpired || isProcessing}
                className={cn(
                  'flex-1 flex-row items-center justify-center py-3 rounded-lg',
                  isExpired || isProcessing ? 'bg-muted' : 'bg-primary'
                )}
              >
                {isProcessing ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <>
                    <Check size={16} className="text-primary-foreground mr-2" />
                    <Text className="text-primary-foreground font-medium">Accept</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                onPress={() => handleDecline(item)}
                disabled={isExpired || isProcessing}
                className="flex-1 flex-row items-center justify-center py-3 rounded-lg border border-border"
              >
                {isProcessing ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <>
                    <X size={16} className="text-foreground mr-2" />
                    <Text className="text-foreground font-medium">Decline</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        )
      }}
    />
  )
}

// --- Main Page ---
export default observer(function MembersPage() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const workspaces = useWorkspaceCollection()
  const membersColl = useMemberCollection()
  const invitationsColl = useInvitationCollection()
  const actions = useDomainActions()

  const [activeTab, setActiveTab] = useState<TabId>('members')
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!isAuthenticated) return
    const load = async () => {
      setIsLoading(true)
      try {
        await workspaces.loadAll({})
        if (user?.id) {
          await membersColl.loadAll({ userId: user.id })
        }
      } catch {
        // handled in tabs
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [isAuthenticated, user?.id])

  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  const currentUserRole = useMemo(() => {
    if (!user?.id || !currentWorkspace) return undefined
    const membership = membersColl.all.find(
      (m: any) => m.userId === user.id && m.workspaceId === currentWorkspace.id
    )
    return membership?.role as 'owner' | 'admin' | 'member' | 'viewer' | undefined
  }, [user?.id, currentWorkspace, membersColl.all])

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="p-6">
          <View className="animate-pulse gap-4">
            <View className="h-8 w-48 bg-muted rounded" />
            <View className="h-64 bg-muted rounded" />
          </View>
        </View>
      </SafeAreaView>
    )
  }

  if (!currentWorkspace || !user?.id) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center p-6">
          <Users size={48} className="text-muted-foreground mb-4" />
          <Text className="text-foreground text-xl font-semibold mb-2">
            No Workspace Selected
          </Text>
          <Text className="text-muted-foreground text-center mb-4">
            Select a workspace from the dropdown to manage members.
          </Text>
          <Pressable
            onPress={() => router.back()}
            className="flex-row items-center border border-border rounded-lg px-4 py-2.5"
          >
            <ArrowLeft size={16} className="text-foreground mr-2" />
            <Text className="text-foreground font-medium">Back to Workspace</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pt-2 pb-3">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} className="p-1.5">
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <View>
            <Text className="text-foreground text-xl font-bold">Members</Text>
            <Text className="text-muted-foreground text-sm">{currentWorkspace.name}</Text>
          </View>
        </View>
        <Pressable
          onPress={() => setIsInviteModalOpen(true)}
          className="flex-row items-center bg-primary rounded-lg px-3.5 py-2"
        >
          <UserPlus size={16} className="text-primary-foreground mr-1.5" />
          <Text className="text-primary-foreground font-medium text-sm">Invite</Text>
        </Pressable>
      </View>

      {/* Tabs */}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <View className="flex-1">
        {activeTab === 'members' && (
          <MembersTab
            orgId={currentWorkspace.id}
            currentUserId={user.id}
            currentUserRole={currentUserRole || 'viewer'}
          />
        )}
        {activeTab === 'pending' && <PendingTab orgId={currentWorkspace.id} />}
        {activeTab === 'my-invitations' && <MyInvitationsTab />}
      </View>

      {/* Invite Modal */}
      <InviteModal
        visible={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        workspaceId={currentWorkspace.id}
        actions={actions}
        currentUserId={user.id}
        invitationCollection={invitationsColl}
      />
    </SafeAreaView>
  )
})
