// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dev-only preview of the desktop permission onboarding steps in a plain
 * browser. Installs a fake `window.shogoDesktop` bridge where "Allow" flips the
 * permission to granted, so every state of the three steps can be exercised
 * without macOS prompts. Open /dev/permission-steps?step=files-apps to jump.
 */
import { useRef, useState } from 'react'
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper'
import { useDesktopPermissionSteps } from '@/components/onboarding/desktop/useDesktopPermissionSteps'

const status: Record<string, string> = {
  accessibility: 'denied',
  screen: 'denied',
  fullDisk: 'denied',
  mic: 'denied',
}

/** Installed when this page renders, not at import: in development every route
 * module is loaded up front, and a fake bridge there makes every page in a
 * plain browser think it is the desktop app. */
function installFakeBridge() {
  if (typeof window === 'undefined' || (window as any).shogoDesktop) return
  ;(window as any).shogoDesktop = {
    isDesktop: true,
    platform: 'darwin',
    permissions: {
      getStatus: async () => ({ ...status }),
      request: async (kind: string) => {
        await new Promise((r) => setTimeout(r, 500))
        status[kind] = 'granted'
        return { state: 'granted', openedSettings: false, status: { ...status } }
      },
      openSettings: async () => {},
      listLocalApps: async () => [
        { id: 'mail', name: 'Mail', installed: true },
        { id: 'messages', name: 'Messages', installed: true },
        { id: 'notes', name: 'Notes', installed: true },
        { id: 'whatsapp', name: 'WhatsApp', installed: false },
      ],
      relaunch: async () => {},
    },
    dictation: {
      getConfig: async () => ({ pushToTalk: 'Fn', handsFree: null }),
      setConfig: async (c: unknown) => ({ ok: true, config: c }),
      getHotkeyState: async () => ({ fnAvailable: true }),
      onEvent: () => () => {},
      deliverText: async () => ({ ok: true }),
    },
  }
}

const IDS = ['computer-use', 'files-apps', 'dictation']

export default function DevPermissionSteps() {
  installFakeBridge()
  const initial =
    typeof window !== 'undefined'
      ? Math.max(0, IDS.indexOf(new URLSearchParams(window.location.search).get('step') ?? ''))
      : 0
  const [active, setActive] = useState(initial)
  const advanceRef = useRef<() => void>(() => {})
  advanceRef.current = () => setActive((i) => Math.min(i + 1, IDS.length - 1))

  const { steps } = useDesktopPermissionSteps({
    enabled: true,
    http: null,
    advanceRef,
    posthog: null as any,
    analyticsContext: {},
  })

  return (
    <OnboardingStepper
      steps={steps}
      activeIndex={active}
      onNext={() => advanceRef.current()}
      onBack={() => setActive((i) => Math.max(0, i - 1))}
      onSkip={() => advanceRef.current()}
    />
  )
}
