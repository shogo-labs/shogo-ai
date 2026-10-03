// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The three desktop-only onboarding steps (computer use, files and local apps,
 * dictation). Kept out of `CloudOnboarding` so the step list, state and
 * persistence live in one testable unit.
 *
 * Permissions are always optional: every step can be skipped, and skipping
 * never ends onboarding (it only advances to the next step).
 */
import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { HttpClient } from '@shogo-ai/sdk'
import { api } from '../../../lib/api'
import { EVENTS, trackEvent } from '../../../lib/analytics'
import { getDesktopBridge, isMacDesktop, type LocalAppId, type PermissionStatus } from '../../../lib/desktop-bridge'
import { defaultLocalAccess, type AppAccess, type LocalAccessPrefs } from '../../../lib/local-access'
import type { StepDef } from '../OnboardingStepper'
import { ComputerUseFootnote, ComputerUseStep } from './ComputerUseStep'
import { DictationStep } from './DictationStep'
import { FilesAppsFootnote, FilesAppsStep } from './FilesAppsStep'
import { ComputerUseHero, DictationHero, FilesAppsHero } from './heroes'

export const DESKTOP_PERMISSION_STEP_IDS = ['computer-use', 'files-apps', 'dictation'] as const
export type DesktopPermissionStepId = (typeof DESKTOP_PERMISSION_STEP_IDS)[number]

export function isDesktopPermissionStep(id: string | undefined): id is DesktopPermissionStepId {
  return !!id && (DESKTOP_PERMISSION_STEP_IDS as readonly string[]).includes(id)
}

/** The permission steps only apply to the macOS desktop shell in local mode. */
export function shouldShowDesktopPermissionSteps(localMode: boolean): boolean {
  return localMode && isMacDesktop()
}

interface Options {
  enabled: boolean
  http: HttpClient | null | undefined
  /** Advances the stepper; called after a step's own Skip. */
  advanceRef: MutableRefObject<() => void>
  posthog: Parameters<typeof trackEvent>[0]
  analyticsContext: Record<string, unknown>
}

export interface DesktopPermissionSteps {
  steps: StepDef[]
  /** Persist and report a step the user is leaving. Never throws. */
  onLeave: (id: DesktopPermissionStepId, outcome: 'continued' | 'skipped') => Promise<void>
}

export function useDesktopPermissionSteps({
  enabled,
  http,
  advanceRef,
  posthog,
  analyticsContext,
}: Options): DesktopPermissionSteps {
  const [prefs, setPrefs] = useState<LocalAccessPrefs>(() => defaultLocalAccess())
  const [fullDiskGranted, setFullDiskGranted] = useState(false)
  const status = useRef<Partial<PermissionStatus>>({})
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const updateStatus = useCallback((next: PermissionStatus) => {
    status.current = { ...status.current, ...next }
    setFullDiskGranted((prev) => (prev === (next.fullDisk === 'granted') ? prev : next.fullDisk === 'granted'))
  }, [])

  const setAppAccess = useCallback((id: LocalAppId, access: AppAccess) => {
    setPrefs((p) => ({ ...p, apps: { ...p.apps, [id]: access } }))
  }, [])

  const persist = useCallback(
    async (id: DesktopPermissionStepId, outcome: 'continued' | 'skipped') => {
      const current = prefsRef.current
      const granted = status.current
      let patch: Partial<LocalAccessPrefs> | null = null

      if (id === 'computer-use') {
        // Computer use needs both OS grants. Skipping records an explicit "off".
        patch = { computerUse: outcome === 'continued' && granted.accessibility === 'granted' && granted.screen === 'granted' }
      } else if (id === 'files-apps') {
        // Per-app choices only mean something once Full Disk Access is on.
        if (outcome === 'continued' && granted.fullDisk === 'granted') patch = { apps: current.apps }
      } else if (id === 'dictation') {
        if (outcome === 'continued' && granted.mic === 'granted') patch = { dictation: current.dictation }
      }

      try {
        if (patch && http) await api.saveLocalAccessPrefs(http, patch)
      } catch (err) {
        console.warn('[Onboarding] Saving local access failed:', err)
      }

      if (id === 'dictation' && outcome === 'continued' && granted.mic === 'granted') {
        try {
          await getDesktopBridge()?.dictation?.setConfig(current.dictation)
        } catch (err) {
          console.warn('[Onboarding] Saving dictation shortcuts failed:', err)
        }
      }

      trackEvent(posthog, EVENTS.ONBOARDING_PERMISSION_RESULT, {
        ...analyticsContext,
        step: id,
        outcome,
        accessibility: granted.accessibility,
        screen: granted.screen,
        full_disk: granted.fullDisk,
        mic: granted.mic,
      })
    },
    [analyticsContext, http, posthog],
  )

  const skipStep = useCallback(
    (id: DesktopPermissionStepId) => () => {
      void persist(id, 'skipped').finally(() => advanceRef.current())
    },
    [advanceRef, persist],
  )

  const steps = useMemo<StepDef[]>(() => {
    if (!enabled) return []
    return [
      {
        id: 'computer-use',
        layout: 'centered',
        hero: <ComputerUseHero />,
        title: 'Allow Shogo to use your computer?',
        subtitle: "Ask Shogo to complete a task, then step away. Shogo has it ready when you're back.",
        body: <ComputerUseStep onStatusChange={updateStatus} />,
        footnote: <ComputerUseFootnote />,
        skipLabel: 'Skip',
        onSkip: skipStep('computer-use'),
      },
      {
        id: 'files-apps',
        layout: 'centered',
        hero: <FilesAppsHero />,
        title: 'Allow Shogo to access your files and local apps?',
        subtitle:
          "You don't need to hunt through folders, notes and messages anymore. With your approval, Shogo can find, read and edit your files and local apps.",
        body: <FilesAppsStep value={prefs.apps} onChange={setAppAccess} onStatusChange={updateStatus} />,
        footnote: <FilesAppsFootnote showAppNote={fullDiskGranted} />,
        skipLabel: 'Skip',
        onSkip: skipStep('files-apps'),
      },
      {
        id: 'dictation',
        layout: 'centered',
        hero: <DictationHero />,
        title: 'Enable dictation',
        subtitle: 'Turn speech to text using a seamless voice-first workflow.',
        body: (
          <DictationStep
            value={prefs.dictation}
            onChange={(dictation) => setPrefs((p) => ({ ...p, dictation }))}
            onStatusChange={updateStatus}
          />
        ),
        skipLabel: 'Skip',
        onSkip: skipStep('dictation'),
      },
    ]
  }, [enabled, fullDiskGranted, prefs.apps, prefs.dictation, setAppAccess, skipStep, updateStatus])

  return { steps, onLeave: persist }
}
