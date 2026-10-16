// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Onboarding shared by cloud and local/desktop. Every account already owns a
 * Personal space and a Team workspace (created by the signup hook, or seeded
 * by local bootstrap), so this flow creates nothing new: it lets the user name
 * the workspace, invite people and describe what they want to build, then
 * lands them there.
 *
 *   team     -> team-setup -> build-prompt -> SettingUp -> workspace agent chat | builder home
 *   joined   -> joined -> SettingUp -> the workspace they were invited to
 *
 * There is no personal-vs-team choice. Users who were invited into a team
 * workspace go straight to it.
 *
 * Local mode prepends two machine-specific steps: `name` (only while the
 * seeded user still has the placeholder name) and `ai-config` (Shogo Cloud
 * key vs own provider keys). On the macOS desktop app, three optional
 * permission steps follow: `computer-use`, `files-apps` and `dictation`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../contexts/auth'
import {
  useDomainActions,
  useDomainHttp,
  useMemberCollection,
  useWorkspaceCollection,
} from '../../../contexts/domain'
import { usePostHogSafe } from '../../../contexts/posthog'
import { api, type OnboardingIntent } from '../../../lib/api'
import { buildBuildBriefMessage } from '../../chat/turns/buildBrief'
import { EVENTS, trackEvent } from '../../../lib/analytics'
import { safeGetItem, safeRemoveItem } from '../../../lib/safe-storage'
import { setActiveWorkspaceId } from '../../../lib/workspace-store'
import { OnboardingStepper, type StepDef } from '../OnboardingStepper'
import { NameInput } from '../steps/NameInput'
import { AIConfigForm } from '../steps/AIConfigForm'
import { TeamSetupStep } from './TeamSetupStep'
import { parseEmailDraft } from './email-draft'
import { JoinedStep } from './JoinedStep'
import { BuildPromptStep } from './BuildPromptStep'
import { SettingUp } from './SettingUp'
import {
  isDesktopPermissionStep,
  shouldShowDesktopPermissionSteps,
  useDesktopPermissionSteps,
} from '../desktop/useDesktopPermissionSteps'

/** Names the local bootstrap seeds before the user has told us theirs. */
const PLACEHOLDER_USER_NAMES = new Set(['', 'local', 'local user'])
const PLACEHOLDER_TEAM_NAMES = new Set(['my workspace', 'local user team', "local's workspace"])
const PLACEHOLDER_PERSONAL_NAMES = new Set(['local user personal', 'user personal'])

function isPlaceholder(set: Set<string>, name?: string | null): boolean {
  return set.has((name ?? '').trim().toLowerCase())
}

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

/** Keep in sync with `defaultTeamWorkspaceName` in apps/api workspace.service. */
function defaultTeamName(userName?: string | null): string {
  const first = (userName ?? '').trim().split(/\s+/)[0]
  return first ? `${first}'s Workspace` : 'My Workspace'
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/**
 * One in-flight load+backfill per user, so a double mount (StrictMode, fast
 * remounts) can't create a second backfilled workspace.
 */
const workspaceSetups = new Map<string, Promise<void>>()

function ensureWorkspacesOnce(userId: string, run: () => Promise<void>): Promise<void> {
  let pending = workspaceSetups.get(userId)
  if (!pending) {
    pending = run().finally(() => workspaceSetups.delete(userId))
    workspaceSetups.set(userId, pending)
  }
  return pending
}

export const CloudOnboarding = observer(function CloudOnboarding({ localMode = false }: { localMode?: boolean }) {
  const router = useRouter()
  const posthog = usePostHogSafe()
  const { user, signOut, updateUser } = useAuth()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()
  const members = useMemberCollection()

  const [loaded, setLoaded] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [retryingLoad, setRetryingLoad] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  // Fixed at mount so the step list doesn't shift once the name is saved.
  const [askName] = useState(() => localMode && isPlaceholder(PLACEHOLDER_USER_NAMES, user?.name))
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)
  const [aiReady, setAiReady] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [emails, setEmails] = useState<string[]>([])
  const [emailDraft, setEmailDraft] = useState('')
  const [teamError, setTeamError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [savingTeam, setSavingTeam] = useState(false)
  // A marketing-site deep link (`pending_template_id`, a listing slug) seeds the prompt.
  const [buildPrompt, setBuildPrompt] = useState(() => {
    const slug = Platform.OS === 'web' ? safeGetItem('pending_template_id') : null
    return slug ? `Set up the ${slug.replace(/[-_]+/g, ' ')} agent for me` : ''
  })
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  const invitedEmails = useRef(new Set<string>())
  const createdSessionId = useRef<string | null>(null)
  const savedTeamName = useRef<string | null>(null)
  const handleNextRef = useRef<() => void>(() => {})
  const advanceRef = useRef<() => void>(() => {})

  const knownName = isPlaceholder(PLACEHOLDER_USER_NAMES, user?.name) ? nameDraft : user?.name
  const firstName = (knownName ?? '').trim().split(/\s+/)[0] || 'there'

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
  // Everyone lands in a team workspace. Invited users land in the one they joined.
  type Destination = 'team' | 'joined'
  const destination: Destination = joinedTeamWorkspace ? 'joined' : 'team'

  // Load workspaces + memberships, backfilling either own workspace if the
  // signup hook didn't create it (older accounts, or the hook failed).
  // Re-runs when the user retries from the team-setup step.
  useEffect(() => {
    if (!user?.id) return
    const userId = user.id
    const userName = isPlaceholder(PLACEHOLDER_USER_NAMES, user.name) ? null : user.name
    let cancelled = false
    const load = () =>
      Promise.all([workspaces.loadAll(), members.loadAll({ userId })])

    void ensureWorkspacesOnce(userId, async () => {
      try {
        await load()
        const ws = (workspaces.all ?? []) as unknown as WorkspaceRow[]
        const mine = ((members.all ?? []) as unknown as MemberRow[]).filter((m) => m.userId === userId)
        const ownsTeam = ws.some(
          (w) => w.kind !== 'personal' && mine.some((m) => m.workspaceId === w.id && m.role === 'owner'),
        )
        const hasPersonal = ws.some((w) => w.kind === 'personal')
        const backfills: Promise<unknown>[] = []
        if (!hasPersonal) backfills.push(api.createPersonalWorkspace(http))
        if (!ownsTeam) backfills.push(actions.createWorkspace(defaultTeamName(userName), undefined, userId))
        if (backfills.length) {
          const results = await Promise.allSettled(backfills)
          for (const r of results) {
            if (r.status === 'rejected') console.warn('[Onboarding] Workspace backfill failed:', r.reason)
          }
          await load()
        }
      } catch (err) {
        console.warn('[Onboarding] Failed to load workspaces:', err)
      }
    }).finally(() => {
      if (cancelled) return
      setLoaded(true)
      setRetryingLoad(false)
    })
    return () => {
      cancelled = true
    }
    // Run once per user (and per retry); collections are stable store references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, loadAttempt])

  const retryLoad = useCallback(() => {
    setRetryingLoad(true)
    setTeamError(null)
    setLoadAttempt((n) => n + 1)
  }, [])

  // Seed defaults once the workspaces are known.
  useEffect(() => {
    if (!loaded) return
    if (ownTeamWorkspace && !teamName) setTeamName(ownTeamWorkspace.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, ownTeamWorkspace?.id])

  const intent: OnboardingIntent = 'team'
  const analyticsContext = useMemo(
    () => ({ mode: localMode ? 'local' : 'cloud', destination, intent }),
    [localMode, destination, intent],
  )
  const [showPermissionSteps] = useState(() => shouldShowDesktopPermissionSteps(localMode))
  const permissionSteps = useDesktopPermissionSteps({
    enabled: showPermissionSteps,
    http,
    advanceRef,
    posthog,
    analyticsContext,
  })
  const displayTeamName = teamName.trim() || ownTeamWorkspace?.name || 'your workspace'
  const draftInvalid = parseEmailDraft(emailDraft).invalid

  const targetWorkspaceId = destination === 'joined' ? joinedTeamWorkspace?.id : ownTeamWorkspace?.id

  // Start claiming / booting the workspace agent's runtime now, so it is warm
  // by the time the user finishes the remaining steps and sends a first turn.
  const prewarmedWorkspaceId = useRef<string | null>(null)
  useEffect(() => {
    if (!loaded || !targetWorkspaceId) return
    if (prewarmedWorkspaceId.current === targetWorkspaceId) return
    prewarmedWorkspaceId.current = targetWorkspaceId
    void api.prewarmWorkspaceRuntime(http, targetWorkspaceId, { source: 'onboarding' })
  }, [loaded, targetWorkspaceId, http])

  const settingUpMessage =
    destination === 'joined'
      ? `Opening ${joinedTeamWorkspace?.name ?? 'your team'}…`
      : buildPrompt.trim()
        ? 'Starting your workspace agent…'
        : `Opening ${displayTeamName}…`

  const navigateToWorkspace = useCallback(
    (workspaceId: string | undefined) => {
      if (workspaceId) setActiveWorkspaceId(workspaceId)
      router.replace('/(app)')
    },
    [router],
  )

  const finish = useCallback(async (promptOverride?: string) => {
    const prompt = (promptOverride !== undefined ? promptOverride : buildPrompt).trim()
    setFinishing(true)
    setFinishError(null)
    try {
      await api.completeOnboarding(http, intent ? { intent } : undefined)
      safeRemoveItem('pending_template_id')

      if (destination === 'team' && prompt && ownTeamWorkspace) {
        if (!createdSessionId.current) {
          const session = await api.createWorkspaceSession(http, ownTeamWorkspace.id, {
            inferredName: prompt.slice(0, 60),
          })
          createdSessionId.current = session.id
        }
        setActiveWorkspaceId(ownTeamWorkspace.id)
        trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, {
          ...analyticsContext,
          build_prompt: true,
        })
        router.replace({
          pathname: '/(app)/agent',
          params: {
            chatSessionId: createdSessionId.current,
            initialMessage: buildBuildBriefMessage(prompt),
          },
        } as any)
        return
      }

      trackEvent(posthog, EVENTS.ONBOARDING_COMPLETED, {
        ...analyticsContext,
        build_prompt: false,
      })
      navigateToWorkspace(targetWorkspaceId)
    } catch (err) {
      console.error('[Onboarding] Completion failed:', err)
      setFinishError(errorMessage(err, "We couldn't finish setting up. Check your connection and try again."))
    }
  }, [
    analyticsContext,
    buildPrompt,
    destination,
    http,
    intent,
    navigateToWorkspace,
    ownTeamWorkspace,
    posthog,
    router,
    targetWorkspaceId,
  ])

  const saveName = useCallback(async (): Promise<boolean> => {
    const name = nameDraft.trim()
    if (!name) {
      setNameError('Tell us what to call you to continue.')
      return false
    }
    if (name === user?.name) return true
    setNameError(null)
    setSavingName(true)
    try {
      await updateUser({ name })
    } catch (err) {
      setNameError(errorMessage(err, "Couldn't save your name. Try again."))
      return false
    } finally {
      setSavingName(false)
    }

    // The seeded workspaces were named after the placeholder; follow the real
    // name unless the user already renamed them.
    const renames: Promise<unknown>[] = []
    const currentTeamName = savedTeamName.current ?? ownTeamWorkspace?.name
    if (ownTeamWorkspace && isPlaceholder(PLACEHOLDER_TEAM_NAMES, currentTeamName)) {
      const next = defaultTeamName(name)
      renames.push(
        actions.updateWorkspace(ownTeamWorkspace.id, { name: next }).then(() => {
          savedTeamName.current = next
        }),
      )
      setTeamName((t) => (isPlaceholder(PLACEHOLDER_TEAM_NAMES, t) ? next : t))
    }
    if (personalWorkspace && isPlaceholder(PLACEHOLDER_PERSONAL_NAMES, personalWorkspace.name)) {
      renames.push(actions.updateWorkspace(personalWorkspace.id, { name: `${name} Personal` }))
    }
    for (const r of await Promise.allSettled(renames)) {
      if (r.status === 'rejected') console.warn('[Onboarding] Workspace rename failed:', r.reason)
    }
    return true
  }, [actions, nameDraft, ownTeamWorkspace, personalWorkspace, updateUser, user?.name])

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
    const { valid: draftEmails, invalid } = parseEmailDraft(emailDraft)
    if (invalid.length) return false
    setTeamError(null)
    setInviteError(null)
    setSavingTeam(true)
    try {
      const currentName = savedTeamName.current ?? ownTeamWorkspace.name
      const renamed = name !== currentName
      if (renamed) {
        await actions.updateWorkspace(ownTeamWorkspace.id, { name })
        savedTeamName.current = name
      }

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
      const failed: string[] = []
      results.forEach((r, i) => {
        const email = toInvite[i]!
        if (r.status === 'fulfilled') invitedEmails.current.add(email)
        else {
          console.warn('[Onboarding] Invite failed:', email, r.reason)
          const reason = r.reason instanceof Error && r.reason.message ? ` (${r.reason.message})` : ''
          failed.push(`${email}${reason}`)
        }
      })
      trackEvent(posthog, EVENTS.ONBOARDING_TEAM_SETUP_COMPLETED, {
        ...analyticsContext,
        renamed,
        invites: toInvite.length - failed.length,
        invite_failures: failed.length,
      })
      if (failed.length) {
        setInviteError(
          `Couldn't invite ${failed.join(', ')}. Remove ${failed.length === 1 ? 'it' : 'them'}, or press Continue to try again.`,
        )
        return false
      }
      return true
    } catch (err) {
      setTeamError(errorMessage(err, "Couldn't save your workspace name. Try again."))
      return false
    } finally {
      setSavingTeam(false)
    }
  }, [actions, analyticsContext, emailDraft, emails, ownTeamWorkspace, posthog, teamName])

  const steps: StepDef[] = useMemo(() => {
    const list: StepDef[] = []
    if (askName) {
      list.push({
        id: 'name',
        title: 'Welcome to Shogo. What should we call you?',
        subtitle: 'Shogo runs entirely on this machine. Your name is only used here.',
        busy: savingName,
        canContinue: nameDraft.trim().length > 0,
        body: (
          <NameInput
            value={nameDraft}
            onChange={(n) => {
              setNameDraft(n)
              if (nameError) setNameError(null)
            }}
            onSubmit={() => handleNextRef.current()}
            error={nameError}
          />
        ),
      })
    }
    if (localMode) {
      list.push({
        id: 'ai-config',
        title: askName && nameDraft.trim()
          ? `Nice to meet you, ${firstName}. How should we power your agents?`
          : 'How should we power your agents?',
        subtitle: 'Connect a Shogo Cloud API key or use your own provider keys. You can change this later in settings.',
        canContinue: aiReady,
        skipLabel: 'Skip for now',
        body: <AIConfigForm onReadyChange={setAiReady} />,
      })
    }
    list.push(...permissionSteps.steps)
    if (destination === 'team') {
      list.push(
        {
          id: 'team-setup',
          eyebrow: 'Team workspace',
          title: 'Set up your team workspace',
          subtitle: 'This is where you and your teammates build projects and agents.',
          busy: savingTeam,
          canContinue: !!ownTeamWorkspace && teamName.trim().length > 0 && draftInvalid.length === 0,
          body: ownTeamWorkspace ? (
            <TeamSetupStep
              name={teamName}
              onNameChange={(n) => {
                setTeamName(n)
                if (teamError) setTeamError(null)
              }}
              emails={emails}
              onEmailsChange={(next) => {
                setEmails(next)
                if (inviteError) setInviteError(null)
              }}
              draft={emailDraft}
              onDraftChange={setEmailDraft}
              error={teamError}
              inviteError={inviteError}
              onSubmit={() => handleNextRef.current()}
            />
          ) : (
            <View className="items-start gap-3 rounded-xl border border-border bg-card p-5">
              <Text className="text-base font-medium text-foreground">
                Your team workspace isn't ready yet
              </Text>
              <Text className="text-sm leading-5 text-muted-foreground">
                We couldn't finish creating it. Check your connection and try again.
              </Text>
              <Button variant="outline" onPress={retryLoad} disabled={retryingLoad}>
                {retryingLoad ? 'Retrying…' : 'Try again'}
              </Button>
            </View>
          ),
        },
        {
          id: 'build-prompt',
          eyebrow: displayTeamName,
          title: 'What do you want to build?',
          subtitle: 'Tell your workspace agent about it. You can change direction anytime.',
          canContinue: buildPrompt.trim().length > 0,
          primaryLabel: 'Start building',
          skipLabel: "I'll explore first",
          body: (
            <BuildPromptStep
              value={buildPrompt}
              onChange={setBuildPrompt}
              onSubmit={() => handleNextRef.current()}
            />
          ),
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
    aiReady,
    askName,
    destination,
    displayTeamName,
    draftInvalid.length,
    emailDraft,
    emails,
    firstName,
    inviteError,
    joinedTeamWorkspace?.id,
    joinedTeamWorkspace?.name,
    localMode,
    nameDraft,
    nameError,
    ownTeamWorkspace?.id,
    permissionSteps.steps,
    retryingLoad,
    retryLoad,
    buildPrompt,
    savingName,
    savingTeam,
    teamError,
    teamName,
  ])

  const advance = useCallback(() => {
    if (activeIndex >= steps.length - 1) {
      void finish()
      return
    }
    setActiveIndex((i) => i + 1)
  }, [activeIndex, finish, steps.length])
  advanceRef.current = advance

  const handleNext = useCallback(async () => {
    const step = steps[activeIndex]
    if (!step || step.busy || step.canContinue === false) return
    if (step.id === 'name' && !(await saveName())) return
    if (step.id === 'team-setup' && !(await saveTeamSetup())) return
    if (isDesktopPermissionStep(step.id)) await permissionSteps.onLeave(step.id, 'continued')
    advance()
  }, [activeIndex, advance, analyticsContext, permissionSteps, posthog, saveName, saveTeamSetup, steps])

  handleNextRef.current = () => void handleNext()

  const handleSkip = useCallback(() => {
    // Permission steps skip themselves (see `StepDef.onSkip`); this is only a
    // safety net so a skip there can never complete onboarding.
    if (steps[activeIndex]?.id === 'ai-config' || isDesktopPermissionStep(steps[activeIndex]?.id)) {
      advance()
      return
    }
    setBuildPrompt('')
    void finish('')
  }, [activeIndex, advance, finish, steps])

  const handleStepViewed = useCallback(
    (step: StepDef, index: number) => {
      trackEvent(posthog, EVENTS.ONBOARDING_STEP_VIEWED, { ...analyticsContext, step: step.id, index })
    },
    [posthog, analyticsContext],
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
