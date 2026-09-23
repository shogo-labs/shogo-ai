// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud onboarding. Every cloud account already owns a Personal space and a
 * Team workspace (created by the signup hook), so this flow creates nothing
 * new: it asks where the user wants to start, lets team-first users name the
 * workspace, invite people and install a first agent, then lands them there.
 *
 *   personal -> SettingUp -> companion chat (seeded prompt)
 *   team     -> team-setup -> agent-picker -> SettingUp -> project | builder home
 *   joined   -> joined -> SettingUp -> the workspace they were invited to
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useAuth } from '../../../contexts/auth'
import {
  useDomainActions,
  useDomainHttp,
  useMemberCollection,
  useWorkspaceCollection,
} from '../../../contexts/domain'
import { usePostHogSafe } from '../../../contexts/posthog'
import { api, getOnboardingMessage, type OnboardingIntent } from '../../../lib/api'
import { EVENTS, trackEvent } from '../../../lib/analytics'
import { safeGetItem, safeRemoveItem } from '../../../lib/safe-storage'
import { setActiveWorkspaceId } from '../../../lib/workspace-store'
import { setChatPrefill } from '../../../hooks/useChatPrefill'
import { OnboardingStepper, type StepDef } from '../OnboardingStepper'
import { DestinationStep, type Destination } from './DestinationStep'
import { TeamSetupStep } from './TeamSetupStep'
import { parseEmailDraft } from './email-draft'
import { JoinedStep } from './JoinedStep'
import { AgentPickerStep, type OnboardingListing } from './AgentPickerStep'
import { SettingUp } from './SettingUp'

const PERSONAL_SEED_PROMPT = 'Help me plan my week.'

interface WorkspaceRow {
  id: string
  name: string
  kind?: 'personal' | 'team'
}

interface MemberRow {
  workspaceId?: string
  role?: string
  userId?: string
}

function defaultTeamName(userName?: string | null): string {
  const first = (userName ?? '').trim().split(/\s+/)[0]
  return first ? `${first}'s Workspace` : 'My Workspace'
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export const CloudOnboarding = observer(function CloudOnboarding() {
  const router = useRouter()
  const posthog = usePostHogSafe()
  const { user, signOut } = useAuth()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()

  const [loaded, setLoaded] = useState(false)
  const [destination, setDestination] = useState<Destination | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [teamName, setTeamName] = useState('')
  const [emails, setEmails] = useState<string[]>([])
  const [emailDraft, setEmailDraft] = useState('')
  const [teamError, setTeamError] = useState<string | null>(null)
  const [savingTeam, setSavingTeam] = useState(false)
  const [selectedListing, setSelectedListing] = useState<OnboardingListing | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  const invitedEmails = useRef(new Set<string>())
  const installedProjectId = useRef<string | null>(null)
  const savedTeamName = useRef<string | null>(null)

  const firstName = (user?.name ?? '').trim().split(/\s+/)[0] || 'there'

  const allWorkspaces = (workspaces.all ?? []) as unknown as WorkspaceRow[]
  const myMemberships = ((members.all ?? []) as unknown as MemberRow[]).filter(
    (m) => !user?.id || m.userId === user.id,
  )
  const roleFor = (workspaceId: string) => myMemberships.find((m) => m.workspaceId === workspaceId)?.role

  const personalWorkspace = allWorkspaces.find((w) => w.kind === 'personal')
  const ownTeamWorkspace = allWorkspaces.find((w) => w.kind !== 'personal' && roleFor(w.id) === 'owner')
  const joinedTeamWorkspace = allWorkspaces.find(
    (w) => w.kind !== 'personal' && roleFor(w.id) && roleFor(w.id) !== 'owner',
  )

  // Load workspaces + memberships, backfilling either own workspace if the
  // signup hook didn't create it (older accounts, or the hook failed).
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    const load = () =>
      Promise.all([workspaces.loadAll(), members.loadAll({ userId: user.id })])

    ;(async () => {
      try {
        await load()
        const ws = (workspaces.all ?? []) as unknown as WorkspaceRow[]
        const mine = ((members.all ?? []) as unknown as MemberRow[]).filter((m) => m.userId === user.id)
        const ownsTeam = ws.some(
          (w) => w.kind !== 'personal' && mine.some((m) => m.workspaceId === w.id && m.role === 'owner'),
        )
        const hasPersonal = ws.some((w) => w.kind === 'personal')
        const backfills: Promise<unknown>[] = []
        if (!hasPersonal) backfills.push(api.createPersonalWorkspace(http))
        if (!ownsTeam) backfills.push(actions.createWorkspace(defaultTeamName(user.name), undefined, user.id))
        if (backfills.length) {
          const results = await Promise.allSettled(backfills)
          for (const r of results) {
            if (r.status === 'rejected') console.warn('[Onboarding] Workspace backfill failed:', r.reason)
          }
          await load()
        }
      } catch (err) {
        console.warn('[Onboarding] Failed to load workspaces:', err)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // Run once per user; collections are stable store references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Seed defaults once the workspaces are known.
  useEffect(() => {
    if (!loaded) return
    if (ownTeamWorkspace && !teamName) setTeamName(ownTeamWorkspace.name)
    if (destination) return
    if (joinedTeamWorkspace) setDestination('joined')
    else if (Platform.OS === 'web' && safeGetItem('pending_template_id')) setDestination('team')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ownTeamWorkspace?.id, joinedTeamWorkspace?.id])

  const intent: OnboardingIntent = destination === 'personal' ? 'personal' : 'team'
  const path = destination === 'joined' ? 'invited' : destination ?? 'personal'
  const displayTeamName = teamName.trim() || ownTeamWorkspace?.name || 'your workspace'

  const targetWorkspaceId =
    destination === 'personal'
      ? personalWorkspace?.id
      : destination === 'joined'
        ? joinedTeamWorkspace?.id
        : ownTeamWorkspace?.id

  const settingUpMessage =
    destination === 'personal'
      ? 'Opening your companion…'
      : destination === 'joined'
        ? `Opening ${joinedTeamWorkspace?.name ?? 'your team'}…`
        : selectedListing
          ? `Installing ${selectedListing.title}…`
          : `Opening ${displayTeamName}…`

  const navigateToWorkspace = useCallback(
    (workspaceId: string | undefined) => {
      if (workspaceId) setActiveWorkspaceId(workspaceId)
      router.replace('/(app)')
    },
    [router],
  )

  const finish = useCallback(async (listingOverride?: OnboardingListing | null) => {
    const listing = listingOverride !== undefined ? listingOverride : selectedListing
    setFinishing(true)
    setFinishError(null)
    try {
      await api.completeOnboarding(http, { intent })

      if (destination === 'team' && listing && ownTeamWorkspace) {
        if (!installedProjectId.current) {
          const installed = await actions.installListing(listing.slug, ownTeamWorkspace.id)
          if (!installed?.projectId) throw new Error(`Couldn't install ${listing.title}.`)
          installedProjectId.current = installed.projectId
          trackEvent(posthog, EVENTS.PROJECT_CREATED, {
            source: 'onboarding',
            listing_slug: listing.slug,
            listing_title: listing.title,
          })
        }
        const chatSession = await actions.createChatSession({
          inferredName: 'Untitled',
          contextType: 'project',
          contextId: installedProjectId.current,
        })
        safeRemoveItem('pending_template_id')
        setActiveWorkspaceId(ownTeamWorkspace.id)
        trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, {
          mode: 'cloud',
          intent,
          path,
          installed_listing: listing.slug,
        })
        router.replace({
          pathname: '/(app)/projects/[id]',
          params: {
            id: installedProjectId.current,
            chatSessionId: chatSession.id,
            initialMessage: getOnboardingMessage(listing.title, listing.slug),
            showIntegrations: '1',
            ...(Platform.OS !== 'web' ? { tab: 'chat-fullscreen' } : {}),
          },
        } as any)
        return
      }

      if (destination === 'personal') setChatPrefill(PERSONAL_SEED_PROMPT)
      trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, {
        mode: 'cloud',
        intent,
        path,
        installed_listing: null,
      })
      navigateToWorkspace(targetWorkspaceId)
    } catch (err) {
      console.error('[Onboarding] Completion failed:', err)
      setFinishError(errorMessage(err, "We couldn't finish setting up. Check your connection and try again."))
    }
  }, [
    actions,
    destination,
    http,
    intent,
    selectedListing,
    navigateToWorkspace,
    ownTeamWorkspace,
    path,
    posthog,
    router,
    targetWorkspaceId,
  ])

  const saveTeamSetup = useCallback(async (): Promise<boolean> => {
    const name = teamName.trim()
    if (!name) {
      setTeamError('Give your workspace a name to continue.')
      return false
    }
    if (!ownTeamWorkspace) {
      setTeamError("Your team workspace isn't ready yet. Try again in a moment.")
      return false
    }
    setTeamError(null)
    setSavingTeam(true)
    try {
      const currentName = savedTeamName.current ?? ownTeamWorkspace.name
      const renamed = name !== currentName
      if (renamed) {
        await actions.updateWorkspace(ownTeamWorkspace.id, { name })
        savedTeamName.current = name
      }

      const { valid: draftEmails } = parseEmailDraft(emailDraft)
      const allEmails = [...new Set([...emails, ...draftEmails])]
      if (draftEmails.length) {
        setEmails(allEmails)
        setEmailDraft('')
      }
      const toInvite = allEmails.filter((e) => !invitedEmails.current.has(e))
      const results = await Promise.allSettled(
        toInvite.map((email) =>
          actions.sendInvitation({ email, role: 'member', workspaceId: ownTeamWorkspace.id }),
        ),
      )
      let failures = 0
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') invitedEmails.current.add(toInvite[i]!)
        else {
          failures++
          console.warn('[Onboarding] Invite failed:', toInvite[i], r.reason)
        }
      })
      trackEvent(posthog, EVENTS.ONBOARDING_TEAM_SETUP, {
        renamed,
        invites: toInvite.length - failures,
        invite_failures: failures,
      })
      return true
    } catch (err) {
      setTeamError(errorMessage(err, "Couldn't save your workspace name. Try again."))
      return false
    } finally {
      setSavingTeam(false)
    }
  }, [actions, emailDraft, emails, ownTeamWorkspace, posthog, teamName])

  const steps: StepDef[] = useMemo(() => {
    const list: StepDef[] = [
      {
        id: 'destination',
        title: `Welcome, ${firstName}. Where do you want to start?`,
        subtitle: 'You have both. Switch anytime from your avatar.',
        width: 'grid',
        canContinue: !!destination,
        primaryLabel: destination === 'personal' ? 'Open my companion' : 'Continue',
        body: (
          <DestinationStep
            value={destination}
            onChange={setDestination}
            joinedWorkspaceName={joinedTeamWorkspace?.name}
          />
        ),
      },
    ]
    if (destination === 'team') {
      list.push(
        {
          id: 'team-setup',
          eyebrow: 'Team workspace',
          title: 'Set up your team workspace',
          subtitle: 'This is where you and your teammates build projects and agents.',
          busy: savingTeam,
          canContinue: teamName.trim().length > 0,
          body: (
            <TeamSetupStep
              name={teamName}
              onNameChange={(n) => {
                setTeamName(n)
                if (teamError) setTeamError(null)
              }}
              emails={emails}
              onEmailsChange={setEmails}
              draft={emailDraft}
              onDraftChange={setEmailDraft}
              error={teamError}
            />
          ),
        },
        {
          id: 'agent-picker',
          eyebrow: displayTeamName,
          title: 'Start with an agent',
          subtitle: 'Pick one to install now, or start from scratch. You can add more from the marketplace anytime.',
          width: 'grid',
          primaryLabel: selectedListing ? `Install ${selectedListing.title}` : `Open ${displayTeamName}`,
          skipLabel: selectedListing ? "I'll start from scratch" : undefined,
          body: <AgentPickerStep selected={selectedListing} onSelect={setSelectedListing} />,
        },
      )
    }
    if (destination === 'joined' && joinedTeamWorkspace) {
      list.push({
        id: 'joined',
        eyebrow: 'Invitation accepted',
        title: `You've joined ${joinedTeamWorkspace.name}`,
        subtitle: 'Here is everything you have access to.',
        primaryLabel: `Open ${joinedTeamWorkspace.name}`,
        body: <JoinedStep workspaceName={joinedTeamWorkspace.name} role={roleFor(joinedTeamWorkspace.id)} />,
      })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    destination,
    displayTeamName,
    emailDraft,
    emails,
    firstName,
    joinedTeamWorkspace?.id,
    joinedTeamWorkspace?.name,
    selectedListing,
    savingTeam,
    teamError,
    teamName,
  ])

  const handleNext = useCallback(async () => {
    const step = steps[activeIndex]
    if (!step) return
    if (step.id === 'destination') {
      trackEvent(posthog, EVENTS.ONBOARDING_INTENT_SELECTED, { destination, intent })
    }
    if (step.id === 'team-setup' && !(await saveTeamSetup())) return
    if (step.id === 'agent-picker' && selectedListing) {
      trackEvent(posthog, EVENTS.ONBOARDING_AGENT_SELECTED, { listing_slug: selectedListing.slug })
    }
    if (activeIndex >= steps.length - 1) {
      void finish()
      return
    }
    setActiveIndex((i) => i + 1)
  }, [activeIndex, destination, finish, intent, selectedListing, posthog, saveTeamSetup, steps])

  const handleSkip = useCallback(() => {
    setSelectedListing(null)
    safeRemoveItem('pending_template_id')
    void finish(null)
  }, [finish])

  const handleStepViewed = useCallback(
    (step: StepDef, index: number) => {
      trackEvent(posthog, EVENTS.ONBOARDING_STEP_VIEWED, { step: step.id, index, intent: destination })
    },
    [posthog, destination],
  )

  if (!loaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (finishing) {
    return (
      <SettingUp
        message={settingUpMessage}
        error={finishError}
        onRetry={() => void finish()}
        onContinueAnyway={() => navigateToWorkspace(targetWorkspaceId)}
      />
    )
  }

  return (
    <OnboardingStepper
      steps={steps}
      activeIndex={activeIndex}
      onNext={() => void handleNext()}
      onBack={() => setActiveIndex((i) => Math.max(0, i - 1))}
      onSkip={handleSkip}
      onStepViewed={handleStepViewed}
      onSignOut={() => void signOut()}
    />
  )
})
