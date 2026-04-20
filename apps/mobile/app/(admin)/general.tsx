// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin General Settings - Shogo Cloud connection, cloud registration, and appearance.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
} from 'react-native'
import {
  Cloud,
  CheckCircle,
  AlertTriangle,
  Unplug,
  Palette,
  Check,
  Wifi,
  WifiOff,
  Monitor,
  Info,
  LogIn,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi, type InstanceInfo } from '@shogo-ai/sdk'
import { API_URL, createHttpClient } from '../../lib/api'
import { useAccentTheme } from '../../contexts/accent-theme'
import { ACCENT_PRESETS, ACCENT_NAMES } from '../../lib/accent-themes'

/** True when this window is the Electron desktop shell — only then can we
 * use the native system-browser handshake. Metro dev or a plain browser
 * pointed at the local API falls through to a popup-window flow. */
function hasDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.startCloudLogin
}

const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'

export default function AdminGeneralPage() {
  const [shogoKeyConnected, setShogoKeyConnected] = useState(false)
  const [shogoKeyMask, setShogoKeyMask] = useState('')
  const [shogoWorkspaceName, setShogoWorkspaceName] = useState('')
  const [shogoEmail, setShogoEmail] = useState('')
  const [loginStatus, setLoginStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [loginError, setLoginError] = useState('')
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [cloudUrl, setCloudUrl] = useState(SHOGO_CLOUD_URL_DEFAULT)

  const [cloudUrlDraft, setCloudUrlDraft] = useState(SHOGO_CLOUD_URL_DEFAULT)
  const [isSavingCloudUrl, setIsSavingCloudUrl] = useState(false)
  const [cloudUrlError, setCloudUrlError] = useState('')

  const [instanceInfo, setInstanceInfo] = useState<InstanceInfo | null>(null)
  const [instanceNameDraft, setInstanceNameDraft] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)

  const [isLoading, setIsLoading] = useState(true)
  const [buildVersion, setBuildVersion] = useState<{ version: string; buildHash: string } | null>(null)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const fetchInstanceInfo = useCallback(async () => {
    try {
      const info = await platform.getInstanceInfo()
      setInstanceInfo(info)
      setInstanceNameDraft(info.name)
    } catch (err) {
      console.error('[AdminGeneral] Failed to load instance info:', err)
    }
  }, [platform])

  const loadStatus = useCallback(async () => {
    try {
      const status = await platform.cloudLoginStatus()
      setShogoKeyConnected(status.signedIn)
      setShogoEmail(status.email || '')
      setShogoWorkspaceName(status.workspace?.name || '')
      setShogoKeyMask(status.keyPrefix ? `${status.keyPrefix}…` : '')
      if (status.cloudUrl) {
        setCloudUrl(status.cloudUrl)
        setCloudUrlDraft(status.cloudUrl)
      }
      if (status.signedIn) {
        fetchInstanceInfo()
      }
    } catch (err) {
      console.error('[AdminGeneral] Failed to load cloud-login status:', err)
    }
  }, [platform, fetchInstanceInfo])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await loadStatus()
      if (!cancelled) setIsLoading(false)
    })()

    fetch(`${API_URL}/api/version`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.version) setBuildVersion(data)
      })
      .catch(() => {})

    // The Electron main process fires this when the shogo://auth-callback
    // deep link completes. Reload status to pick up the new signed-in state.
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
      if (result.ok) {
        setLoginStatus('idle')
        setLoginError('')
        void loadStatus()
      } else {
        setLoginStatus('error')
        setLoginError(result.error || 'Sign-in was cancelled')
      }
    })

    return () => {
      cancelled = true
      desktop?.removeCloudLoginListener?.()
    }
  }, [platform, fetchInstanceInfo, loadStatus])

  const handleStartLogin = async () => {
    setLoginStatus('connecting')
    setLoginError('')
    try {
      if (hasDesktopBridge()) {
        // Electron main process does the full handshake: mints a device key
        // via the cloud bridge page, writes it to local config, then fires
        // `cloud-login-result`. We just wait for that event.
        const result = await (window as any).shogoDesktop.startCloudLogin()
        if (!result?.ok) {
          setLoginStatus('error')
          setLoginError(result?.error || 'Could not start sign-in')
        }
        return
      }
      // Dev fallback (Metro/browser): ask the local API to produce an authUrl
      // and open it in a new tab. The bridge page will still redirect to
      // shogo://auth-callback, which won't work without the desktop shell —
      // so we also surface a hint so devs can paste the callback manually.
      const start = await platform.startCloudLogin({
        id: 'dev-browser',
        name: 'Dev Browser',
        platform: 'web',
        appVersion: '0.0.0-dev',
      })
      if (!start.ok) {
        setLoginStatus('error')
        setLoginError('Could not start sign-in')
        return
      }
      if (typeof window !== 'undefined') {
        window.open(start.authUrl, '_blank', 'noopener,noreferrer')
      }
      setLoginStatus('idle')
    } catch (err: any) {
      setLoginStatus('error')
      setLoginError(err?.message || 'Sign-in failed')
    }
  }

  const handleDisconnectShogoKey = async () => {
    setIsDisconnecting(true)
    try {
      if (hasDesktopBridge() && (window as any).shogoDesktop?.signOutCloud) {
        await (window as any).shogoDesktop.signOutCloud()
      } else {
        await platform.signOutCloud()
      }
      setShogoKeyConnected(false)
      setShogoKeyMask('')
      setShogoWorkspaceName('')
      setShogoEmail('')
      setLoginStatus('idle')
      setInstanceInfo(null)
    } catch (err) {
      console.error('[AdminGeneral] Failed to sign out of Shogo Cloud:', err)
    } finally {
      setIsDisconnecting(false)
    }
  }

  const handleCloudUrlBlur = async () => {
    const trimmed = cloudUrlDraft.trim().replace(/\/$/, '')
    if (!trimmed || trimmed === cloudUrl) {
      setCloudUrlDraft(cloudUrl)
      return
    }
    setIsSavingCloudUrl(true)
    setCloudUrlError('')
    try {
      const data = await platform.updateShogoCloudUrl(trimmed)
      if (data.ok) {
        setCloudUrl(trimmed)
        setCloudUrlDraft(trimmed)
        setShogoWorkspaceName(data.workspace?.name || '')
        fetchInstanceInfo()
      } else {
        setCloudUrlError(data.error || 'Failed to validate key against new URL')
        setCloudUrlDraft(cloudUrl)
      }
    } catch (err: any) {
      setCloudUrlError(err.message || 'Connection failed')
      setCloudUrlDraft(cloudUrl)
    } finally {
      setIsSavingCloudUrl(false)
    }
  }

  const handleInstanceNameBlur = async () => {
    const trimmed = instanceNameDraft.trim()
    if (!trimmed || trimmed === instanceInfo?.name) {
      if (instanceInfo) setInstanceNameDraft(instanceInfo.name)
      return
    }
    setIsSavingName(true)
    try {
      await platform.updateInstanceName(trimmed)
      setTimeout(() => fetchInstanceInfo(), 2000)
    } catch (err) {
      console.error('[AdminGeneral] Failed to update instance name:', err)
      if (instanceInfo) setInstanceNameDraft(instanceInfo.name)
    } finally {
      setIsSavingName(false)
    }
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
      <View className="max-w-2xl w-full mx-auto gap-8">
        {/* Header */}
        <View>
          <Text className="text-2xl font-bold text-foreground">General</Text>
          <Text className="text-sm text-muted-foreground mt-1">
            Cloud connection, appearance, and machine registration.
          </Text>
        </View>

        {/* Shogo Cloud Connection */}
        <SectionCard
          icon={Cloud}
          title="Shogo Cloud"
          description="Connect this machine to your Shogo Cloud account"
        >
          {shogoKeyConnected ? (
            <View className="gap-3">
              <View className="flex-row items-center gap-2 bg-green-500/10 rounded-lg p-3">
                <CheckCircle size={16} className="text-green-500" />
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">
                    Signed in{shogoEmail ? ` as ${shogoEmail}` : ''}
                  </Text>
                  {shogoWorkspaceName ? (
                    <Text className="text-xs text-muted-foreground">
                      Workspace: {shogoWorkspaceName}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View className="flex-row items-center gap-2">
                {shogoKeyMask ? (
                  <Text className="text-xs text-muted-foreground font-mono flex-1">
                    {shogoKeyMask}
                  </Text>
                ) : (
                  <View className="flex-1" />
                )}
                <Pressable
                  onPress={handleDisconnectShogoKey}
                  disabled={isDisconnecting}
                  className={cn(
                    'flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30',
                    isDisconnecting && 'opacity-50',
                  )}
                >
                  <Unplug size={14} className="text-destructive" />
                  <Text className="text-sm text-destructive">
                    {isDisconnecting ? 'Signing out...' : 'Sign out'}
                  </Text>
                </Pressable>
              </View>
              <View className="gap-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Cloud URL
                  </Text>
                  {isSavingCloudUrl && <ActivityIndicator size="small" />}
                </View>
                <TextInput
                  value={cloudUrlDraft}
                  onChangeText={(t) => {
                    setCloudUrlDraft(t)
                    setCloudUrlError('')
                  }}
                  onBlur={handleCloudUrlBlur}
                  onSubmitEditing={handleCloudUrlBlur}
                  editable={!isSavingCloudUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className={cn(
                    'border rounded-lg px-3 py-2 text-sm text-foreground bg-background web:outline-none',
                    cloudUrlError ? 'border-destructive' : 'border-border',
                  )}
                />
                {cloudUrlError ? (
                  <View className="flex-row items-center gap-1.5">
                    <AlertTriangle size={14} className="text-destructive" />
                    <Text className="text-xs text-destructive">{cloudUrlError}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          ) : (
            <View className="gap-3">
              <Text className="text-sm text-muted-foreground">
                Sign in with your Shogo Cloud account to use cloud models, share
                instances, and manage this machine from your dashboard.
              </Text>
              <Pressable
                onPress={handleStartLogin}
                disabled={loginStatus === 'connecting'}
                className={cn(
                  'flex-row items-center justify-center gap-2 px-4 py-2.5 rounded-lg',
                  loginStatus === 'connecting' ? 'bg-muted' : 'bg-primary',
                )}
              >
                {loginStatus === 'connecting' ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <LogIn size={16} className="text-primary-foreground" />
                )}
                <Text
                  className={cn(
                    'text-sm font-medium',
                    loginStatus === 'connecting'
                      ? 'text-muted-foreground'
                      : 'text-primary-foreground',
                  )}
                >
                  {loginStatus === 'connecting'
                    ? 'Waiting for browser…'
                    : 'Sign in to Shogo Cloud'}
                </Text>
              </Pressable>
              {loginError ? (
                <View className="flex-row items-center gap-1.5">
                  <AlertTriangle size={14} className="text-destructive" />
                  <Text className="text-sm text-destructive">{loginError}</Text>
                </View>
              ) : null}
              <Text className="text-xs text-muted-foreground">
                Your browser will open to {cloudUrl.replace(/^https?:\/\//, '')}. After
                you sign in, this app will automatically reconnect.
              </Text>
              <View className="gap-1">
                <Text className="text-xs font-medium text-muted-foreground">Cloud URL</Text>
                <TextInput
                  value={cloudUrl}
                  onChangeText={setCloudUrl}
                  placeholder={SHOGO_CLOUD_URL_DEFAULT}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground web:outline-none"
                />
                <Text className="text-xs text-muted-foreground">
                  Override for self-hosted or staging environments
                </Text>
              </View>
            </View>
          )}
        </SectionCard>

        {/* Cloud Registration Info */}
        {shogoKeyConnected && instanceInfo && (
          <SectionCard
            icon={Monitor}
            title="Cloud Registration"
            description="How this machine appears on your Shogo Cloud dashboard"
          >
            <View className="gap-4">
              <View className="gap-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Machine Name
                  </Text>
                  {isSavingName && <ActivityIndicator size="small" />}
                </View>
                <TextInput
                  value={instanceNameDraft}
                  onChangeText={setInstanceNameDraft}
                  onBlur={handleInstanceNameBlur}
                  onSubmitEditing={handleInstanceNameBlur}
                  editable={!isSavingName}
                  autoCapitalize="none"
                  className="border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background web:outline-none"
                />
              </View>

              <View className="gap-3">
                <InfoRow label="Hostname" value={instanceInfo.hostname} />
                <InfoRow
                  label="OS / Architecture"
                  value={`${instanceInfo.os} / ${instanceInfo.arch}`}
                />
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Tunnel Status
                  </Text>
                  <View className="flex-row items-center gap-1.5">
                    {instanceInfo.tunnelConnected ? (
                      <>
                        <Wifi size={12} className="text-green-500" />
                        <Text className="text-sm text-green-500 font-medium">
                          Connected
                        </Text>
                      </>
                    ) : (
                      <>
                        <WifiOff size={12} className="text-destructive" />
                        <Text className="text-sm text-destructive font-medium">
                          Disconnected
                        </Text>
                      </>
                    )}
                  </View>
                </View>
                {instanceInfo.workspaceName && (
                  <InfoRow label="Cloud Workspace" value={instanceInfo.workspaceName} />
                )}
              </View>
            </View>
          </SectionCard>
        )}

        {/* Appearance */}
        <AccentColorPicker />

        {/* Build Info */}
        {buildVersion && (
          <SectionCard
            icon={Info}
            title="About"
            description="Build and version information"
          >
            <View className="gap-3">
              <InfoRow
                label="Version"
                value={buildVersion.version === '0.0.0' ? 'dev' : `v${buildVersion.version}`}
              />
              {buildVersion.buildHash && buildVersion.buildHash !== 'dev' && (
                <InfoRow label="Build" value={buildVersion.buildHash.slice(0, 8)} />
              )}
            </View>
          </SectionCard>
        )}
      </View>
    </ScrollView>
  )
}

// =============================================================================
// Info Row
// =============================================================================

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </Text>
      <Text className="text-sm text-foreground">{value}</Text>
    </View>
  )
}

// =============================================================================
// Accent Color Picker
// =============================================================================

function AccentColorPicker() {
  const { accent, setAccent } = useAccentTheme()

  return (
    <SectionCard
      icon={Palette}
      title="Appearance"
      description="Customize the accent color used throughout the app"
    >
      <View className="flex-row flex-wrap gap-3">
        {ACCENT_NAMES.map((name) => {
          const preset = ACCENT_PRESETS[name]
          const isActive = accent === name
          return (
            <Pressable
              key={name}
              onPress={() => setAccent(name)}
              className="items-center gap-1.5"
            >
              <View
                className={cn(
                  'h-10 w-10 rounded-full items-center justify-center',
                  isActive && 'border-2 border-foreground',
                )}
                style={{ backgroundColor: preset.swatch }}
              >
                {isActive && <Check size={16} color="#fff" strokeWidth={3} />}
              </View>
              <Text
                className={cn(
                  'text-[10px]',
                  isActive ? 'text-foreground font-semibold' : 'text-muted-foreground',
                )}
              >
                {preset.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </SectionCard>
  )
}

// =============================================================================
// Shared Components
// =============================================================================

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: any
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <View className="bg-card border border-border rounded-xl overflow-hidden">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center gap-2.5 mb-1">
          <Icon size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">{title}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      <View className="px-5 py-4">{children}</View>
    </View>
  )
}
