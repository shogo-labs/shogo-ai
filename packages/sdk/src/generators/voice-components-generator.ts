// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Voice Components Generator
 *
 * Emits drop-in React components for pod apps to wire voice into their
 * UI with zero config. Gated on `shogo.config.json → features.voice`
 * (or the equivalent `OutputConfig.generate` inclusion of
 * `'voice-components'`).
 *
 * Output layout (default `dir`):
 *
 *   src/components/shogo/
 *     VoiceButton.tsx     — primary CTA: click to start / stop talking
 *     VoiceSphere.tsx     — animated sphere that pulses while the
 *                           agent speaks; pairs with VoiceButton or
 *                           stands alone.
 *     PhoneButton.tsx     — initiates an outbound Twilio call from a
 *                           project-provisioned number (requires
 *                           `features.voice.phoneNumber` provisioned).
 *     index.ts            — re-exports all three.
 *
 * Every component uses `useShogoVoice()` from `@shogo-ai/sdk/voice/react`
 * which, in a generated pod, auto-detects `RUNTIME_AUTH_SECRET` +
 * `PROJECT_ID` and talks to the pod's local `/api/voice/signed-url`
 * proxy (wired by `createVoiceHandlers()` in `server.tsx`).
 *
 * All files use `skipIfExists: true` — they're scaffolds, not
 * regenerated code. Users are expected to restyle / customize them
 * after first generation, and subsequent `shogo generate` runs will
 * not clobber those edits.
 */

import { GENERATED_FILE_LICENSE_HEADER } from './generated-file-license-header'

export interface VoiceComponentsGeneratorOptions {
  /**
   * File extension for emitted components. Defaults to `tsx`.
   * All three components are JSX, so `ts` is rarely what you want —
   * kept only for symmetry with other generators.
   */
  fileExtension?: 'tsx' | 'ts'
  /**
   * Import path for the SDK's React voice entry. Override only if
   * your pod's bundler resolves the SDK differently (e.g. a local
   * file replacement for offline dev).
   */
  sdkReactImport?: string
}

export interface GeneratedVoiceComponentFile {
  fileName: string
  code: string
  /**
   * Components are scaffolds, not regenerated artifacts. The CLI
   * honors `skipIfExists` so user edits survive future `shogo generate`
   * runs.
   */
  skipIfExists: true
}

const HEADER = GENERATED_FILE_LICENSE_HEADER.trim()

function voiceButtonCode(sdkReactImport: string): string {
  return `${HEADER}
/**
 * VoiceButton — click-to-talk Shogo voice widget.
 *
 * Zero-config in a generated pod: the underlying \`useShogoVoice()\`
 * auto-detects \`RUNTIME_AUTH_SECRET\` + \`PROJECT_ID\` (injected by the
 * runtime) and talks to the pod's \`/api/voice/signed-url\` route,
 * which proxies through the Shogo API with an \`x-runtime-token\`.
 *
 * Customize freely — this file is NOT regenerated after the first
 * \`shogo generate\` run.
 */
import * as React from 'react'
import { useShogoVoice } from '${sdkReactImport}'

export interface VoiceButtonProps {
  /** Label shown when idle. Defaults to "Talk to Shogo". */
  idleLabel?: string
  /** Label shown while a session is active. Defaults to "End call". */
  activeLabel?: string
  /** Optional className for layout / theming. */
  className?: string
  /** Fired when the session transitions to connected. */
  onConnected?: () => void
  /** Fired when the session disconnects. */
  onDisconnected?: () => void
}

export function VoiceButton(props: VoiceButtonProps = {}): React.ReactElement {
  const {
    idleLabel = 'Talk to Shogo',
    activeLabel = 'End call',
    className,
    onConnected,
    onDisconnected,
  } = props
  const { start, end, status, isSpeaking } = useShogoVoice()

  React.useEffect(() => {
    if (status === 'connected') onConnected?.()
    if (status === 'disconnected') onDisconnected?.()
  }, [status, onConnected, onDisconnected])

  const active = status !== 'disconnected'

  return (
    <button
      type="button"
      onClick={active ? end : () => void start()}
      className={className}
      data-shogo-voice-status={status}
      data-shogo-voice-speaking={isSpeaking ? 'true' : 'false'}
      aria-pressed={active}
    >
      {active ? activeLabel : idleLabel}
    </button>
  )
}

export default VoiceButton
`
}

function voiceSphereCode(sdkReactImport: string): string {
  return `${HEADER}
/**
 * VoiceSphere — a minimal animated sphere that pulses while the agent
 * is speaking. Drives its animation off of the \`isSpeaking\` flag from
 * \`useShogoVoice()\`, so it mirrors the actual audio stream rather
 * than a guess based on time.
 *
 * Customize freely — this file is NOT regenerated after the first
 * \`shogo generate\` run.
 */
import * as React from 'react'
import { useShogoVoice } from '${sdkReactImport}'

export interface VoiceSphereProps {
  /** Diameter in pixels. Defaults to 96. */
  size?: number
  /** Optional className for additional styling. */
  className?: string
}

export function VoiceSphere(props: VoiceSphereProps = {}): React.ReactElement {
  const { size = 96, className } = props
  const { status, isSpeaking } = useShogoVoice()
  const scale = isSpeaking ? 1.12 : status === 'connected' ? 1.03 : 1
  return (
    <div
      className={className}
      data-shogo-voice-status={status}
      data-shogo-voice-speaking={isSpeaking ? 'true' : 'false'}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background:
          'radial-gradient(circle at 30% 30%, #93c5fd 0%, #3b82f6 50%, #1e3a8a 100%)',
        transform: \`scale(\${scale})\`,
        transition: 'transform 180ms ease-out',
        boxShadow: isSpeaking
          ? '0 0 36px rgba(59, 130, 246, 0.55)'
          : '0 0 12px rgba(59, 130, 246, 0.2)',
      }}
    />
  )
}

export default VoiceSphere
`
}

function phoneButtonCode(sdkReactImport: string): string {
  return `${HEADER}
/**
 * PhoneButton — starts an outbound call from the project's
 * provisioned Twilio number to \`phoneNumber\`.
 *
 * Requires voice phone provisioning for the project (see
 * \`shogo enable voice.phoneNumber\` or POST
 * \`/api/voice/twilio/provision-number/:projectId\`). Until a number
 * is provisioned, \`start()\` will 400 and this button surfaces the
 * error via its \`onError\` prop.
 *
 * Customize freely — this file is NOT regenerated after the first
 * \`shogo generate\` run.
 */
import * as React from 'react'
import { shogo, PROJECT_ID } from '../../lib/shogo'

export interface PhoneButtonProps {
  /** E.164 number to dial (e.g. "+15551234567"). Required. */
  phoneNumber: string
  /** Button label. Defaults to "Call". */
  label?: string
  /** Optional className for styling. */
  className?: string
  /** Fired once the call is initiated. */
  onInitiated?: (callId: string) => void
  /** Fired when the SDK reports an error. */
  onError?: (err: Error) => void
}

export function PhoneButton(props: PhoneButtonProps): React.ReactElement {
  const { phoneNumber, label = 'Call', className, onInitiated, onError } = props
  const [pending, setPending] = React.useState(false)

  const onClick = React.useCallback(async () => {
    if (!shogo.voice.telephony) {
      onError?.(
        new Error(
          'shogo.voice.telephony is not configured — ensure RUNTIME_AUTH_SECRET + PROJECT_ID are set.',
        ),
      )
      return
    }
    setPending(true)
    try {
      const result = await shogo.voice.telephony.outboundCall({
        to: phoneNumber,
        projectId: PROJECT_ID,
      })
      onInitiated?.(result.callId ?? '')
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setPending(false)
    }
  }, [phoneNumber, onInitiated, onError])

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={className}
    >
      {pending ? 'Calling…' : label}
    </button>
  )
}

export default PhoneButton
`
}

function indexCode(): string {
  return `${HEADER}
/**
 * Shogo voice components — drop-in UI for the pod-native voice flow.
 *
 * Usage (in your app):
 *
 *     import { VoiceButton, VoiceSphere } from '@/components/shogo'
 *
 *     export default function App() {
 *       return (
 *         <div className="flex items-center gap-4">
 *           <VoiceSphere />
 *           <VoiceButton />
 *         </div>
 *       )
 *     }
 *
 * Customize freely — this file is NOT regenerated after the first
 * \`shogo generate\` run.
 */
export { VoiceButton, type VoiceButtonProps } from './VoiceButton'
export { VoiceSphere, type VoiceSphereProps } from './VoiceSphere'
export { PhoneButton, type PhoneButtonProps } from './PhoneButton'
`
}

/**
 * Generate the Shogo voice component scaffold. Returns one file per
 * component + an `index.ts` barrel.
 */
export function generateVoiceComponents(
  opts: VoiceComponentsGeneratorOptions = {},
): GeneratedVoiceComponentFile[] {
  const ext = opts.fileExtension ?? 'tsx'
  const sdk = opts.sdkReactImport ?? '@shogo-ai/sdk/voice/react'
  return [
    {
      fileName: `VoiceButton.${ext}`,
      code: voiceButtonCode(sdk),
      skipIfExists: true,
    },
    {
      fileName: `VoiceSphere.${ext}`,
      code: voiceSphereCode(sdk),
      skipIfExists: true,
    },
    {
      fileName: `PhoneButton.${ext}`,
      code: phoneButtonCode(sdk),
      skipIfExists: true,
    },
    {
      fileName: 'index.ts',
      code: indexCode(),
      skipIfExists: true,
    },
  ]
}
