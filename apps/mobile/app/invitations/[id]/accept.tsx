// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Emailed invitation acceptance route: `/invitations/<id>/accept`.
 *
 * `apps/api/src/generated/invitation.hooks.ts` mails that exact path (built on
 * `APP_URL`, i.e. this app's origin), so it has to resolve here or the invitee
 * lands on Expo's "Unmatched Route" screen — the SHO-83 bug.
 *
 * Flow:
 *   1. GET  /api/invitations/<id>/info   (public; workspace/project/role/status)
 *   2. Signed out -> /sign-in?next=/invitations/<id>/accept, then back here
 *   3. Signed in  -> the same `acceptInvitation` sequence Settings uses
 *                    (PATCH invitation -> create member), then land at `/`
 *
 * Acceptance goes through `useDomainActions().acceptInvitation` on purpose: it
 * is the one accept path, and it is what fires seat sync and the join mails.
 * Hand-rolling PATCH + POST /api/members here would be a second one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Users, CheckCircle2, AlertTriangle, MailX, Ban } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'
import { DomainProvider, useDomainActions, useWorkspaceCollection } from '../../../contexts/domain'
import { API_URL } from '../../../lib/api'
import {
  invitationAcceptPath,
  invitationPhase,
  normalizeInvitationId,
  type InvitationPhase,
} from '../../../lib/invitation-link'

const ACTIVITY_ON_BRAND = '#ffffff'

/** Payload of `GET /api/invitations/:id/info` — no email address by design. */
interface InvitationInfo {
  role: string
  status: string
  expired: boolean
  workspaceId: string | null
  projectId: string | null
  workspaceName: string | null
  projectName: string | null
}

function roleLabel(role: string | undefined): string {
  if (!role) return 'a teammate'
  if (role === 'owner') return 'an Owner'
  if (role === 'admin') return 'an Admin'
  if (role === 'member') return 'an Editor'
  return `a ${role}`
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
      <View className="w-full max-w-sm rounded-xl border border-border bg-card p-8 items-center" style={{ gap: 24 }}>
        {children}
      </View>
    </SafeAreaView>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center px-6">
      <View className="items-center max-w-sm w-full" style={{ gap: 16 }}>
        {children}
      </View>
    </SafeAreaView>
  )
}

function Loading() {
  return (
    <SafeAreaView className="flex-1 bg-background items-center justify-center">
      <ActivityIndicator size="large" />
    </SafeAreaView>
  )
}

/** "No longer exists" / "expired" / "already used" — no accept button. */
function UnusableInvitation({
  phase,
  info,
  onDashboard,
}: {
  phase: Exclude<InvitationPhase, 'pending'>
  info: InvitationInfo | null
  onDashboard: () => void
}) {
  const copy =
    phase === 'accepted'
      ? 'This invitation has already been used. Ask an admin to send a new one if you still need access.'
      : phase === 'expired'
        ? 'This invitation has expired. Ask an admin to send a new one.'
        : 'This invitation is no longer active. Ask an admin to send a new one.'

  return (
    <Centered>
      {phase === 'accepted' ? (
        <CheckCircle2 size={48} className="text-muted-foreground" />
      ) : (
        <Ban size={48} className="text-muted-foreground" />
      )}
      <Text className="text-xl font-semibold text-foreground text-center">
        {info?.projectName || info?.workspaceName
          ? `Invitation to ${info.projectName || info.workspaceName}`
          : 'Invitation unavailable'}
      </Text>
      <Text className="text-muted-foreground text-center">{copy}</Text>
      <Button className="w-full" onPress={onDashboard}>
        Go to Dashboard
      </Button>
    </Centered>
  )
}

/**
 * Signed-in accept panel. Rendered inside `DomainProvider`, which is what gives
 * `useDomainActions()` a store (same composition as `app/island.tsx`).
 */
function AcceptPanel({ invitationId, info }: { invitationId: string; info: InvitationInfo }) {
  const router = useRouter()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()
  const { user, signOut } = useAuth()

  const [isAccepting, setIsAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [failure, setFailure] = useState<{ wrongAccount: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!accepted) return
    const timer = setTimeout(() => router.replace('/'), 1500)
    return () => clearTimeout(timer)
  }, [accepted, router])

  const handleAccept = useCallback(async () => {
    if (!user?.id) return
    setIsAccepting(true)
    setFailure(null)
    try {
      await actions.acceptInvitation(invitationId, user.id, {
        workspaceId: info.workspaceId ?? '',
        role: info.role,
        projectId: info.projectId ?? undefined,
      })
      // The member row exists now; refresh the workspace list so the new one is
      // in the sidebar when `/` renders instead of after a reload.
      await workspaces.loadAll().catch(() => undefined)
      setAccepted(true)
    } catch (err: any) {
      const message = String(err?.message ?? '')
      if (err?.status === 403 || err?.code === 'FORBIDDEN') {
        setFailure({
          wrongAccount: true,
          text: 'This invitation was sent to a different email address. Sign in with the address the invitation was sent to.',
        })
      } else if (/expired/i.test(message)) {
        setFailure({ wrongAccount: false, text: 'This invitation has expired. Ask an admin to send a new one.' })
      } else if (/no longer be accepted/i.test(message)) {
        setFailure({ wrongAccount: false, text: 'This invitation has already been used.' })
      } else {
        setFailure({ wrongAccount: false, text: message || 'Failed to accept this invitation.' })
      }
    } finally {
      setIsAccepting(false)
    }
  }, [actions, invitationId, info.projectId, info.role, info.workspaceId, user?.id, workspaces])

  if (accepted) {
    return (
      <Centered>
        <CheckCircle2 size={48} className="text-green-500" />
        <Text className="text-xl font-semibold text-foreground text-center">You're in!</Text>
        <Text className="text-muted-foreground text-center">
          You've joined {info.projectName || info.workspaceName || 'the workspace'}. Redirecting…
        </Text>
      </Centered>
    )
  }

  return (
    <Frame>
      <View className="h-16 w-16 rounded-full bg-primary/10 items-center justify-center">
        <Users size={32} className="text-primary" />
      </View>

      <View className="items-center" style={{ gap: 8 }}>
        <Text className="text-xl font-semibold text-foreground text-center">You've been invited</Text>
        <Text className="text-muted-foreground text-center">
          Join <Text className="font-semibold text-foreground">{info.projectName || info.workspaceName || 'this workspace'}</Text> as{' '}
          {roleLabel(info.role)}
        </Text>
      </View>

      <View className="w-full" style={{ gap: 12 }}>
        {failure ? <Text className="text-sm text-destructive text-center">{failure.text}</Text> : null}
        {failure?.wrongAccount ? (
          <Button className="w-full" onPress={() => void signOut()}>
            Sign out
          </Button>
        ) : (
          <Button className="w-full" onPress={handleAccept} disabled={isAccepting || !user?.id}>
            {isAccepting ? <ActivityIndicator color={ACTIVITY_ON_BRAND} /> : 'Accept Invitation'}
          </Button>
        )}
        <Button variant="ghost" className="w-full" onPress={() => router.replace('/')}>
          Not now
        </Button>
      </View>
    </Frame>
  )
}

export default function InvitationAcceptScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const invitationId = useMemo(() => normalizeInvitationId(params.id), [params.id])
  const { isAuthenticated, isLoading: authLoading } = useAuth()

  const [info, setInfo] = useState<InvitationInfo | null>(null)
  const [isLoadingInfo, setIsLoadingInfo] = useState(true)
  const [missing, setMissing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!invitationId) {
      setMissing(true)
      setIsLoadingInfo(false)
      return
    }
    let cancelled = false
    setIsLoadingInfo(true)
    setMissing(false)
    setLoadError(null)

    fetch(`${API_URL}/api/invitations/${encodeURIComponent(invitationId)}/info`, {
      credentials: 'include',
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          data?: InvitationInfo
          error?: string | { message?: string }
        }
        if (cancelled) return
        if (res.status === 404) {
          setMissing(true)
          return
        }
        if (!res.ok || !body.ok || !body.data) {
          const message = typeof body.error === 'string' ? body.error : body.error?.message
          setLoadError(message || 'Failed to load this invitation.')
          return
        }
        setInfo(body.data)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Failed to load this invitation.')
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInfo(false)
      })

    return () => {
      cancelled = true
    }
  }, [invitationId])

  const goToDashboard = useCallback(() => router.replace('/'), [router])
  const goToSignIn = useCallback(() => {
    if (!invitationId) return goToDashboard()
    router.replace({
      pathname: '/(auth)/sign-in',
      params: { next: invitationAcceptPath(invitationId) },
    } as never)
  }, [goToDashboard, invitationId, router])

  if (authLoading || isLoadingInfo) return <Loading />

  if (missing) {
    return (
      <Centered>
        <MailX size={48} className="text-muted-foreground" />
        <Text className="text-xl font-semibold text-foreground text-center">This invitation no longer exists</Text>
        <Text className="text-muted-foreground text-center">
          The link may have been mistyped, or the invitation was deleted. Ask an admin to send a new one.
        </Text>
        <Button className="w-full" onPress={goToDashboard}>
          Go to Dashboard
        </Button>
      </Centered>
    )
  }

  if (loadError || !info) {
    return (
      <Centered>
        <AlertTriangle size={48} className="text-destructive" />
        <Text className="text-xl font-semibold text-foreground text-center">Couldn't load this invitation</Text>
        <Text className="text-muted-foreground text-center">{loadError ?? 'Please try the link again.'}</Text>
        <Button className="w-full" onPress={goToDashboard}>
          Go to Dashboard
        </Button>
      </Centered>
    )
  }

  const phase = invitationPhase(info)
  if (phase !== 'pending') {
    return <UnusableInvitation phase={phase} info={info} onDashboard={goToDashboard} />
  }

  if (!isAuthenticated) {
    return (
      <Frame>
        <View className="h-16 w-16 rounded-full bg-primary/10 items-center justify-center">
          <Users size={32} className="text-primary" />
        </View>
        <View className="items-center" style={{ gap: 8 }}>
          <Text className="text-xl font-semibold text-foreground text-center">You've been invited</Text>
          <Text className="text-muted-foreground text-center">
            Join{' '}
            <Text className="font-semibold text-foreground">
              {info.projectName || info.workspaceName || 'this workspace'}
            </Text>{' '}
            as {roleLabel(info.role)}
          </Text>
        </View>
        <View className="w-full" style={{ gap: 12 }}>
          <Text className="text-sm text-muted-foreground text-center">Sign in to accept this invitation</Text>
          <Button className="w-full" onPress={goToSignIn}>
            Sign In
          </Button>
          <Button variant="ghost" className="w-full" onPress={goToDashboard}>
            Not now
          </Button>
        </View>
      </Frame>
    )
  }

  return (
    <DomainProvider>
      <AcceptPanel invitationId={invitationId!} info={info} />
    </DomainProvider>
  )
}
