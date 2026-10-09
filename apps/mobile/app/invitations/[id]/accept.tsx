// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invitation acceptance route: `/invitations/<id>/accept`.
 *
 * Target of the `acceptUrl` in workspace/project invitation emails and of the
 * `invitation_pending` notification's `actionUrl`
 * (apps/api/src/generated/invitation.hooks.ts). Lives outside `(app)` because
 * that group's auth guard drops the return path; this screen bounces through
 * `/sign-in?next=...` itself.
 *
 * Flow:
 *   1. Signed out -> /(auth)/sign-in?next=/invitations/<id>/accept
 *   2. Signed in  -> find the invitation among the user's received invitations
 *   3. Accept / Decline via the shared `usePendingInvitations` actions
 */
import { useCallback, useMemo } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AlertTriangle, Users } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'
import { DomainProvider } from '../../../contexts/domain'
import { InvitationRow } from '../../../components/layout/sidebar/InboxPanel'
import { usePendingInvitations } from '../../../lib/use-pending-invitations'
import { setActiveWorkspaceId } from '../../../lib/workspace-store'

function InvitationAcceptContent({ id }: { id: string }) {
  const router = useRouter()
  const { user } = useAuth()
  const { pendingInvites, processingInvite, isLoading, acceptInvite, declineInvite } =
    usePendingInvitations()

  const invite = useMemo(() => pendingInvites.find((i: any) => i.id === id), [pendingInvites, id])

  const goHome = useCallback(() => router.replace('/'), [router])

  const handleAccept = useCallback(
    async (target: any) => {
      const ok = await acceptInvite(target)
      if (!ok) return
      if (target.workspaceId) setActiveWorkspaceId(target.workspaceId)
      router.replace('/')
    },
    [acceptInvite, router],
  )

  const handleDecline = useCallback(
    async (target: any) => {
      const ok = await declineInvite(target)
      if (ok) router.replace('/')
    },
    [declineInvite, router],
  )

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </SafeAreaView>
    )
  }

  if (!invite) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
        <View className="items-center max-w-sm w-full" style={{ gap: 16 }}>
          <AlertTriangle size={48} className="text-destructive" />
          <Text className="text-xl font-semibold text-foreground text-center">Invitation not found</Text>
          <Text className="text-muted-foreground text-center">
            This invitation was sent to a different email address or is no longer available.
            {user?.email ? ` You are signed in as ${user.email}.` : ''}
          </Text>
          <Button className="w-full" onPress={goHome}>
            Go to Dashboard
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-full max-w-sm rounded-xl border border-border bg-card py-6 items-center" style={{ gap: 12 }}>
        <View className="h-14 w-14 rounded-full bg-primary/10 items-center justify-center">
          <Users size={28} className="text-primary" />
        </View>
        <Text className="text-xl font-semibold text-foreground text-center">You've been invited</Text>
        <View className="w-full">
          <InvitationRow
            invite={invite}
            processingInvite={processingInvite}
            onAccept={handleAccept}
            onDecline={handleDecline}
            bordered={false}
          />
        </View>
      </View>
    </SafeAreaView>
  )
}

export default function InvitationAcceptScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { isAuthenticated, isLoading: authLoading } = useAuth()

  const goToSignIn = useCallback(() => {
    router.replace({
      pathname: '/(auth)/sign-in',
      params: { next: `/invitations/${id}/accept` },
    } as never)
  }, [router, id])

  if (authLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </SafeAreaView>
    )
  }

  if (!id) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
        <View className="items-center max-w-sm w-full" style={{ gap: 16 }}>
          <AlertTriangle size={48} className="text-destructive" />
          <Text className="text-xl font-semibold text-foreground text-center">Invalid invitation link</Text>
          <Button className="w-full" onPress={() => router.replace('/')}>
            Go to Dashboard
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
        <View className="items-center max-w-sm w-full" style={{ gap: 16 }}>
          <Users size={48} className="text-primary" />
          <Text className="text-xl font-semibold text-foreground text-center">You've been invited</Text>
          <Text className="text-muted-foreground text-center">Sign in to view and accept this invitation.</Text>
          <Button className="w-full" onPress={goToSignIn}>
            Sign In
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <DomainProvider>
      <InvitationAcceptContent id={id} />
    </DomainProvider>
  )
}
