// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
} from 'react-native'
import {
  Cloud,
  Key,
  Check,
  AlertTriangle,
  CheckCircle,
  ArrowRight,
  LogIn,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi } from '@shogo-ai/sdk'
import { createHttpClient } from '../../../lib/api'
import { ProviderSetupCard } from '../../admin/ProviderSetupCard'

function hasDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.startCloudLogin
}

type AIConfigMode = 'shogo-cloud' | 'api-keys' | null

interface AIConfigFormProps {
  onComplete: () => void
  onSkip: () => void
}

export function AIConfigForm({ onComplete, onSkip }: AIConfigFormProps) {
  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const [aiMode, setAiMode] = useState<AIConfigMode>(null)
  const [shogoKeyError, setShogoKeyError] = useState('')
  const [shogoSignedIn, setShogoSignedIn] = useState(false)
  const [shogoEmail, setShogoEmail] = useState('')
  const [shogoWorkspace, setShogoWorkspace] = useState('')
  const [shogoLoginStatus, setShogoLoginStatus] = useState<'idle' | 'connecting'>('idle')
  const [isSaving, setIsSaving] = useState(false)

  // Pick up an existing cloud sign-in (e.g. from a previous onboarding run or
  // a separate sign-in tab that just finished). On the desktop, we get a push
  // notification via the bridge; in browsers we poll while we're "connecting"
  // and also re-check whenever this tab regains focus so a new-tab handshake
  // is detected as soon as the user comes back.
  useEffect(() => {
    let cancelled = false

    const refreshStatus = async (): Promise<boolean> => {
      try {
        const status = await platform.cloudLoginStatus()
        if (cancelled) return false
        if (status.signedIn) {
          setShogoSignedIn(true)
          setShogoEmail(status.email || '')
          setShogoWorkspace(status.workspace?.name || '')
          setShogoLoginStatus('idle')
          setShogoKeyError('')
          return true
        }
      } catch {
        // Local API not reachable — onboarding can still proceed with other modes.
      }
      return false
    }

    void refreshStatus()

    const onFocus = () => {
      if (!shogoSignedIn) void refreshStatus()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus)
    }

    const desktop = (typeof window !== 'undefined' ? (window as any).shogoDesktop : null) as
      | {
          onCloudLoginResult?: (
            cb: (r: { ok: boolean; error?: string; email?: string; workspace?: string }) => void,
          ) => void
          removeCloudLoginListener?: () => void
        }
      | null
    desktop?.onCloudLoginResult?.((result) => {
      if (cancelled) return
      setShogoLoginStatus('idle')
      if (result.ok) {
        setShogoSignedIn(true)
        setShogoEmail(result.email || '')
        setShogoWorkspace(result.workspace || '')
        setShogoKeyError('')
      } else {
        setShogoKeyError(result.error || 'Sign-in was cancelled')
      }
    })

    return () => {
      cancelled = true
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus)
      }
      desktop?.removeCloudLoginListener?.()
    }
  }, [platform, shogoSignedIn])

  // While the user is in the "Waiting for browser…" state, poll the local API
  // so the moment the other tab persists the device key we move forward.
  useEffect(() => {
    if (shogoSignedIn || shogoLoginStatus !== 'connecting') return
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const status = await platform.cloudLoginStatus()
        if (cancelled) return
        if (status.signedIn) {
          setShogoSignedIn(true)
          setShogoEmail(status.email || '')
          setShogoWorkspace(status.workspace?.name || '')
          setShogoLoginStatus('idle')
          setShogoKeyError('')
        }
      } catch {
        // Transient — keep polling.
      }
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [platform, shogoSignedIn, shogoLoginStatus])

  const handleStartShogoLogin = useCallback(async () => {
    setShogoLoginStatus('connecting')
    setShogoKeyError('')
    try {
      if (hasDesktopBridge()) {
        const result = await (window as any).shogoDesktop.startCloudLogin()
        if (!result?.ok) {
          setShogoLoginStatus('idle')
          setShogoKeyError(result?.error || 'Could not start sign-in')
        }
        return
      }
      // No desktop bridge: this is a Metro/browser preview. Sign-in needs
      // the desktop shell or the `shogo` CLI to drive the poll loop.
      setShogoLoginStatus('idle')
      setShogoKeyError(
        'Browser preview can\u2019t complete sign-in. Open the Shogo Desktop app, or run `shogo login` in your terminal.',
      )
    } catch (err: any) {
      setShogoLoginStatus('idle')
      setShogoKeyError(err?.message || 'Sign-in failed')
    }
  }, [platform])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    setShogoKeyError('')
    try {
      // Nothing to persist here: cloud sign-in already stored the device key,
      // and api-keys mode saves keys + enabled models inline via ProviderSetupCard.
      onComplete()
    } catch {
      // stay on step
    } finally {
      setIsSaving(false)
    }
  }, [onComplete])

  const isSaveDisabled =
    isSaving ||
    !aiMode ||
    (aiMode === 'shogo-cloud' && !shogoSignedIn)

  return (
    <View className="gap-4">
      {/* Mode cards */}
      <View className="gap-2.5">
        <ModeCard
          icon={Cloud}
          label="Shogo Cloud"
          description="No API keys needed"
          isSelected={aiMode === 'shogo-cloud'}
          onPress={() => setAiMode('shogo-cloud')}
        />
        <ModeCard
          icon={Key}
          label="Your Own API Keys"
          description="Anthropic or OpenAI"
          isSelected={aiMode === 'api-keys'}
          onPress={() => setAiMode('api-keys')}
        />
      </View>

      {/* Shogo Cloud form */}
      {aiMode === 'shogo-cloud' && (
        <View className="gap-3 bg-card border border-border rounded-xl p-4">
          {shogoSignedIn ? (
            <View className="flex-row items-center gap-2">
              <CheckCircle size={16} className="text-green-500" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  Signed in{shogoEmail ? ` as ${shogoEmail}` : ''}
                </Text>
                {shogoWorkspace ? (
                  <Text className="text-xs text-muted-foreground">
                    Workspace: {shogoWorkspace}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : (
            <>
              <Text className="text-xs text-muted-foreground leading-4">
                Sign in with your Shogo Cloud account. Your browser will open to
                complete the login, then this app will reconnect automatically.
              </Text>
              <Pressable
                onPress={handleStartShogoLogin}
                disabled={shogoLoginStatus === 'connecting'}
                className={cn(
                  'flex-row items-center justify-center gap-2 px-4 py-2.5 rounded-lg',
                  shogoLoginStatus === 'connecting' ? 'bg-muted' : 'bg-primary',
                )}
              >
                {shogoLoginStatus === 'connecting' ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <LogIn size={14} color="#fff" />
                )}
                <Text
                  className={cn(
                    'text-sm font-medium',
                    shogoLoginStatus === 'connecting'
                      ? 'text-muted-foreground'
                      : 'text-primary-foreground',
                  )}
                >
                  {shogoLoginStatus === 'connecting'
                    ? 'Waiting for browser…'
                    : 'Sign in to Shogo Cloud'}
                </Text>
              </Pressable>
            </>
          )}
          {shogoKeyError ? (
            <View className="flex-row items-center gap-1.5">
              <AlertTriangle size={14} className="text-destructive" />
              <Text className="text-xs text-destructive">{shogoKeyError}</Text>
            </View>
          ) : null}
        </View>
      )}

      {/* API Keys form */}
      {aiMode === 'api-keys' && (
        <View className="gap-3 bg-card border border-border rounded-xl p-4">
          <ProviderSetupCard platform={platform} localMode={true} embedded />
        </View>
      )}

      {/* Actions */}
      {aiMode && (
        <Pressable
          onPress={handleSave}
          disabled={isSaveDisabled}
          className={cn(
            'flex-row items-center justify-center gap-2 py-3 rounded-xl',
            isSaveDisabled ? 'bg-primary/30' : 'bg-primary'
          )}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Text className="text-sm font-semibold text-primary-foreground">Save & Continue</Text>
              <ArrowRight size={16} color="#fff" />
            </>
          )}
        </Pressable>
      )}

      <Pressable onPress={onSkip} className="items-center py-1.5">
        <Text className="text-xs text-muted-foreground">Skip for now</Text>
      </Pressable>
    </View>
  )
}

function ModeCard({
  icon: Icon,
  label,
  description,
  isSelected,
  onPress,
}: {
  icon: typeof Cloud
  label: string
  description: string
  isSelected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 p-3.5 rounded-xl border',
        isSelected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
    >
      <View
        className={cn(
          'w-9 h-9 rounded-lg items-center justify-center',
          isSelected ? 'bg-primary/10' : 'bg-muted'
        )}
      >
        <Icon size={18} className={isSelected ? 'text-primary' : 'text-muted-foreground'} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      {isSelected && <Check size={16} className="text-primary" />}
    </Pressable>
  )
}


