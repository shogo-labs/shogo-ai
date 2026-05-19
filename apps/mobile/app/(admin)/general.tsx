// SPDX-License-Identifier: MIT
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
import { Linking } from 'react-native'
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
  Flag,
  RotateCcw,
  RefreshCw,
  KeyRound,
  ExternalLink,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { PlatformApi, type InstanceInfo, type FeatureFlagOverrides } from '@shogo-ai/sdk'
import { API_URL, createHttpClient } from '../../lib/api'
import { useAccentTheme } from '../../contexts/accent-theme'
import { ACCENT_PRESETS, ACCENT_NAMES } from '../../lib/accent-themes'
import { usePlatformConfig, invalidatePlatformConfigCache } from '../../lib/platform-config'

/** True when this window is the Electron desktop shell — only then can we
 * use the native system-browser handshake. Metro dev or a plain browser
 * pointed at the local API falls through to a popup-window flow. */
function hasDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).shogoDesktop?.startCloudLogin
}

const SHOGO_CLOUD_URL_DEFAULT = 'https://studio.shogo.ai'

export default function AdminGeneralPage() {
  const { localMode } = usePlatformConfig()
  const [shogoKeyConnected, setShogoKeyConnected] = useState(false)
  const [shogoKeyMask, setShogoKeyMask] = useState('')
  const [shogoWorkspaceName, setShogoWorkspaceName] = useState('')
  const [shogoEmail, setShogoEmail] = useState('')
  const [loginStatus, setLoginStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [loginError, setLoginError] = useState('')
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [cloudKeyRejected, setCloudKeyRejected] = useState(false)
  // Browser-preview fallback: when no Electron bridge is present we can't
  // drive the device-flow, so the user pastes a `shogo_sk_` API key minted
  // from the cloud dashboard. We POST it to PUT /api/local/shogo-key, which
  // validates against cloud, persists to localConfig, and restarts the
  // instance tunnel — same end state as the desktop sign-in flow.
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [isSubmittingKey, setIsSubmittingKey] = useState(false)
  // Cloud URL is read-only; it reflects the API server's `SHOGO_CLOUD_URL`
  // env var (default https://studio.shogo.ai) and is not user-editable.
  const [cloudUrl, setCloudUrl] = useState(SHOGO_CLOUD_URL_DEFAULT)

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
      setCloudKeyRejected(!!status.cloudKeyRejected)
      if (status.cloudUrl) {
        setCloudUrl(status.cloudUrl)
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

    // The Electron main process fires this once the poll-based cloud
    // sign-in completes (see apps/desktop/src/main.ts → runCloudSignIn).
    // Reload status to pick up the new signed-in state.
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

    // Listen for periodic cloud-connection health updates from the
    // desktop heartbeat. This surfaces key-rejected warnings without
    // signing the user out.
    const desktopExt = desktop as any
    desktopExt?.onCloudConnectionStatus?.((status: { connected: boolean; cloudKeyRejected: boolean; error?: string }) => {
      if (cancelled) return
      setCloudKeyRejected(status.cloudKeyRejected)
    })

    return () => {
      cancelled = true
      desktop?.removeCloudLoginListener?.()
      desktopExt?.removeCloudConnectionStatusListener?.()
    }
  }, [platform, fetchInstanceInfo, loadStatus])

  const handleStartLogin = async () => {
    setLoginStatus('connecting')
    setLoginError('')
    try {
      if (hasDesktopBridge()) {
        // Electron main process drives the cloud /api/cli/login/{start,poll}
        // device flow, persists the minted key via PUT /api/local/shogo-key,
        // then fires `cloud-login-result`. We just wait for that event.
        const result = await (window as any).shogoDesktop.startCloudLogin()
        if (!result?.ok) {
          setLoginStatus('error')
          setLoginError(result?.error || 'Could not start sign-in')
        }
        return
      }
      // No desktop bridge: this build is running in a plain browser (Metro
      // dev preview). Sign-in needs the desktop shell or the `shogo` CLI
      // to drive the poll loop and persist the minted key.
      setLoginStatus('error')
      setLoginError(
        'Browser preview can\u2019t complete sign-in. Use the Shogo Desktop app, or run `shogo login` in your terminal.',
      )
    } catch (err: any) {
      setLoginStatus('error')
      setLoginError(err?.message || 'Sign-in failed')
    }
  }

  /**
   * Browser-preview sign-in fallback: persist a `shogo_sk_` API key the user
   * minted from the cloud dashboard. Hits the same `PUT /api/local/shogo-key`
   * endpoint the desktop bridge calls after its device-flow completes, so the
   * resulting state — `localConfig.SHOGO_API_KEY`, instance tunnel restart,
   * General-page status — is identical.
   *
   * Only invoked when `!hasDesktopBridge()`. The desktop shell uses
   * `handleStartLogin` instead.
   */
  const handleSubmitApiKey = async () => {
    const key = apiKeyDraft.trim()
    if (!key) {
      setLoginStatus('error')
      setLoginError('Paste a Shogo Cloud API key (starts with shogo_sk_).')
      return
    }
    if (!key.startsWith('shogo_sk_')) {
      setLoginStatus('error')
      setLoginError('Invalid key format. Cloud API keys start with shogo_sk_.')
      return
    }
    setIsSubmittingKey(true)
    setLoginStatus('connecting')
    setLoginError('')
    try {
      const res = await fetch(`${API_URL}/api/local/shogo-key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        credentials: 'include',
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!res.ok || !data.ok) {
        setLoginStatus('error')
        setLoginError(
          data.error || `Cloud rejected the key (HTTP ${res.status}).`,
        )
        return
      }
      setApiKeyDraft('')
      setLoginStatus('idle')
      await loadStatus()
    } catch (err: any) {
      setLoginStatus('error')
      setLoginError(err?.message || 'Could not reach the local API.')
    } finally {
      setIsSubmittingKey(false)
    }
  }

  /**
   * Re-run the cloud-login flow without disconnecting first, so the user
   * can switch the device key to a different workspace they belong to.
   * We deliberately don't pass `{ workspaceId }` so the bridge always
   * shows its picker (even when only one workspace exists, in which case
   * the picker auto-skips and just refreshes the key).
   *
   * TODO: cloud's per-workspace dedup at apps/api/src/routes/api-keys.ts
   * lines 162-171 only revokes prior device keys within the *new*
   * workspace, so the previously-bound workspace will keep a dangling
   * `apiKey` row for this device. Cleaning that up needs a cross-workspace
   * dedup pass on the cloud side; out of scope for the picker landing.
   */
  const handleSwitchWorkspace = async () => {
    setLoginStatus('connecting')
    setLoginError('')
    try {
      if (hasDesktopBridge()) {
        const result = await (window as any).shogoDesktop.startCloudLogin()
        if (!result?.ok) {
          setLoginStatus('error')
          setLoginError(result?.error || 'Could not start workspace switch')
        }
        return
      }
      setLoginStatus('error')
      setLoginError(
        'Browser preview can\u2019t switch workspaces. Use the Shogo Desktop app, or rerun `shogo login` in your terminal.',
      )
    } catch (err: any) {
      setLoginStatus('error')
      setLoginError(err?.message || 'Workspace switch failed')
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
      setCloudKeyRejected(false)
      setLoginStatus('idle')
      setInstanceInfo(null)
    } catch (err) {
      console.error('[AdminGeneral] Failed to sign out of Shogo Cloud:', err)
    } finally {
      setIsDisconnecting(false)
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

        {/* Feature Flags — platform-wide, cloud-only (no meaning on a single-user local install). */}
        {!localMode && <FeatureFlagsCard />}

        {/* Shogo Cloud Connection */}
        <SectionCard
          icon={Cloud}
          title="Shogo Cloud"
          description="Connect this machine to your Shogo Cloud account"
        >
          {shogoKeyConnected ? (
            <View className="gap-3">
              <View className={cn(
                'flex-row items-center gap-2 rounded-lg p-3',
                cloudKeyRejected ? 'bg-orange-500/10 border border-orange-500/20' : 'bg-green-500/10',
              )}>
                {cloudKeyRejected ? (
                  <AlertTriangle size={16} className="text-orange-500" />
                ) : (
                  <CheckCircle size={16} className="text-green-500" />
                )}
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
              {cloudKeyRejected && (
                <View className="flex-row items-start gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg p-3">
                  <AlertTriangle size={16} className="text-orange-500 mt-0.5" />
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-foreground">
                      Cloud connection issue
                    </Text>
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      Your API key may have been revoked or expired on the cloud.
                      Sign out and sign in again to refresh your connection.
                    </Text>
                  </View>
                </View>
              )}
              <View className="flex-row items-center gap-2">
                {shogoKeyMask ? (
                  <Text className="text-xs text-muted-foreground font-mono flex-1">
                    {shogoKeyMask}
                  </Text>
                ) : (
                  <View className="flex-1" />
                )}
                {hasDesktopBridge() && (
                  // Switch-workspace re-runs the device flow, which only the
                  // Electron shell can drive. Browser-preview users get the
                  // same outcome via Sign out → paste a different key.
                  <Pressable
                    onPress={handleSwitchWorkspace}
                    disabled={loginStatus === 'connecting' || isDisconnecting}
                    className={cn(
                      'flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border',
                      (loginStatus === 'connecting' || isDisconnecting) && 'opacity-50',
                    )}
                  >
                    {loginStatus === 'connecting' ? (
                      <ActivityIndicator size="small" />
                    ) : (
                      <RefreshCw size={14} className="text-foreground" />
                    )}
                    <Text className="text-sm text-foreground">
                      {loginStatus === 'connecting' ? 'Switching…' : 'Switch workspace'}
                    </Text>
                  </Pressable>
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
                <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Cloud URL
                </Text>
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {cloudUrl}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  Set by the SHOGO_CLOUD_URL environment variable on this machine.
                </Text>
              </View>
            </View>
          ) : (
            <View className="gap-3">
              <Text className="text-sm text-muted-foreground">
                Sign in with your Shogo Cloud account to use cloud models, share
                instances, and manage this machine from your dashboard.
              </Text>
              {hasDesktopBridge() ? (
                <>
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
                </>
              ) : (
                // Browser-preview path: no Electron IPC, so the device-flow
                // can't run. Let the user paste a key minted from the cloud
                // dashboard. Mirrors the desktop sign-in's end state via the
                // same PUT /api/local/shogo-key endpoint.
                <View className="gap-3">
                  <View className="flex-row items-start gap-2 bg-muted/40 border border-border rounded-lg p-3">
                    <Info size={14} className="text-muted-foreground mt-0.5" />
                    <Text className="text-xs text-muted-foreground flex-1">
                      Browser preview can't drive the device sign-in flow. Paste an
                      API key from the cloud dashboard — it has the same effect as
                      signing in from the desktop app.
                    </Text>
                  </View>

                  <View className="gap-1">
                    <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Shogo Cloud API key
                    </Text>
                    <TextInput
                      value={apiKeyDraft}
                      onChangeText={(v) => {
                        setApiKeyDraft(v)
                        if (loginError) {
                          setLoginError('')
                          setLoginStatus('idle')
                        }
                      }}
                      onSubmitEditing={handleSubmitApiKey}
                      placeholder="shogo_sk_..."
                      placeholderTextColor="rgba(115,115,115,0.6)"
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                      editable={!isSubmittingKey}
                      className="border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background font-mono web:outline-none"
                    />
                  </View>

                  <View className="flex-row items-center gap-2">
                    <Pressable
                      onPress={handleSubmitApiKey}
                      disabled={isSubmittingKey || !apiKeyDraft.trim()}
                      className={cn(
                        'flex-row items-center justify-center gap-2 px-4 py-2.5 rounded-lg flex-1',
                        isSubmittingKey || !apiKeyDraft.trim() ? 'bg-muted' : 'bg-primary',
                      )}
                    >
                      {isSubmittingKey ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <KeyRound size={16} className="text-primary-foreground" />
                      )}
                      <Text
                        className={cn(
                          'text-sm font-medium',
                          isSubmittingKey || !apiKeyDraft.trim()
                            ? 'text-muted-foreground'
                            : 'text-primary-foreground',
                        )}
                      >
                        {isSubmittingKey ? 'Connecting…' : 'Connect with API key'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => Linking.openURL(`${cloudUrl}/api-keys`)}
                      className="flex-row items-center gap-1.5 px-3 py-2.5 rounded-lg border border-border"
                    >
                      <ExternalLink size={14} className="text-foreground" />
                      <Text className="text-sm text-foreground">Open dashboard</Text>
                    </Pressable>
                  </View>

                  {loginError ? (
                    <View className="flex-row items-start gap-1.5">
                      <AlertTriangle size={14} className="text-destructive mt-0.5" />
                      <Text className="text-sm text-destructive flex-1">{loginError}</Text>
                    </View>
                  ) : null}

                  <Text className="text-xs text-muted-foreground">
                    Mint a key at {cloudUrl.replace(/^https?:\/\//, '')}/api-keys, paste it above,
                    and the local API will validate it against {cloudUrl.replace(/^https?:\/\//, '')} before saving.
                    To use the one-click flow instead, install the Shogo Desktop app.
                  </Text>
                </View>
              )}
              <View className="gap-1">
                <Text className="text-xs font-medium text-muted-foreground">Cloud URL</Text>
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {cloudUrl}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  Set the SHOGO_CLOUD_URL env var to target staging or a self-hosted cloud.
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
// Feature Flags Card
// =============================================================================

const FEATURE_FLAG_DEFINITIONS: Array<{
  key: keyof FeatureFlagOverrides
  label: string
  hint: string
}> = [
  {
    key: 'marketplace',
    label: 'Marketplace',
    hint: 'Browse, install, and publish agent listings. When off, the Marketplace nav link and screens are hidden.',
  },
  {
    key: 'ezMode',
    label: 'EZ Mode',
    hint: 'Floating voice-mode / translator overlay inside projects. When off, the toggle and overlay are hidden.',
  },
  {
    key: 'phoneChannel',
    label: 'Phone Channel',
    hint: "Twilio + ElevenLabs PSTN calls. When off, the Phone (Voice) section inside a project's Channels tab is hidden.",
  },
]

function FeatureFlagsCard() {
  const [flags, setFlags] = useState<FeatureFlagOverrides>({
    marketplace: null,
    ezMode: null,
    phoneChannel: null,
  })
  const [effective, setEffective] = useState<Record<keyof FeatureFlagOverrides, boolean | null>>({
    marketplace: null,
    ezMode: null,
    phoneChannel: null,
  })
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [pending, setPending] = useState<keyof FeatureFlagOverrides | null>(null)

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  useEffect(() => {
    let cancelled = false
    Promise.all([platform.getFeatureFlags(), platform.getConfig()])
      .then(([overrides, cfg]) => {
        if (cancelled) return
        setFlags(overrides)
        setEffective({
          marketplace: cfg.features?.marketplace ?? null,
          ezMode: cfg.features?.ezMode ?? null,
          phoneChannel: cfg.features?.phoneChannel ?? null,
        })
      })
      .catch((err) => console.error('[FeatureFlags] load failed:', err))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [platform])

  const persist = useCallback(async (key: keyof FeatureFlagOverrides, value: boolean | null) => {
    setPending(key)
    setSaveStatus('saving')
    try {
      const res = await platform.putFeatureFlags({ [key]: value })
      setFlags(res.flags)
      invalidatePlatformConfigCache()
      try {
        const cfg = await platform.getConfig()
        setEffective({
          marketplace: cfg.features?.marketplace ?? null,
          ezMode: cfg.features?.ezMode ?? null,
          phoneChannel: cfg.features?.phoneChannel ?? null,
        })
      } catch {}
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 1500)
    } catch (err) {
      console.error('[FeatureFlags] save failed:', err)
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 2500)
    } finally {
      setPending(null)
    }
  }, [platform])

  return (
    <View className="bg-card border border-border rounded-xl overflow-hidden">
      <View className="px-5 py-4 border-b border-border flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <View className="flex-row items-center gap-2.5 mb-1">
            <Flag size={16} className="text-foreground" />
            <Text className="text-base font-semibold text-foreground">Feature Flags</Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            Turn platform features on or off for all users. Changes take effect on each
            client's next config fetch.
          </Text>
        </View>
        <FeatureFlagsSaveIndicator status={saveStatus} />
      </View>
      <View className="px-5 py-4 gap-4">
        {loading ? (
          <ActivityIndicator />
        ) : (
          FEATURE_FLAG_DEFINITIONS.map((def) => {
            const override = flags[def.key]
            const resolved = override ?? effective[def.key]
            const isOn = resolved === true
            const isDefault = override === null
            const disabled = pending !== null && pending !== def.key
            return (
              <View key={String(def.key)} className="gap-1.5">
                <View className="flex-row items-start gap-3">
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-foreground">{def.label}</Text>
                    <Text className="text-xs text-muted-foreground mt-0.5">{def.hint}</Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      if (disabled) return
                      persist(def.key, !isOn)
                    }}
                    disabled={disabled}
                    className={cn(
                      'h-7 w-12 rounded-full border justify-center px-0.5',
                      isOn ? 'bg-primary border-primary' : 'bg-muted border-border',
                      disabled && 'opacity-60',
                    )}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: isOn, disabled }}
                    accessibilityLabel={`${def.label} feature flag`}
                  >
                    <View
                      className={cn(
                        'h-5 w-5 rounded-full bg-background',
                        isOn ? 'self-end' : 'self-start',
                      )}
                    />
                  </Pressable>
                </View>
                <View className="flex-row items-center gap-2">
                  <Text className="text-[11px] text-muted-foreground">
                    {isDefault
                      ? `Using platform default (${isOn ? 'on' : 'off'})`
                      : `Overridden: ${isOn ? 'on' : 'off'}`}
                  </Text>
                  {!isDefault && (
                    <Pressable
                      onPress={() => {
                        if (disabled) return
                        persist(def.key, null)
                      }}
                      disabled={disabled}
                      className="flex-row items-center gap-1 px-1.5 py-0.5 rounded active:bg-muted"
                    >
                      <RotateCcw size={10} className="text-muted-foreground" />
                      <Text className="text-[11px] text-muted-foreground">Reset</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )
          })
        )}
      </View>
    </View>
  )
}

function FeatureFlagsSaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null
  return (
    <View className="flex-row items-center gap-1.5">
      {status === 'saving' && <ActivityIndicator size="small" />}
      {status === 'saved' && <CheckCircle size={14} className="text-green-500" />}
      {status === 'error' && <AlertTriangle size={14} className="text-destructive" />}
      <Text className={cn(
        'text-xs',
        status === 'saving' && 'text-muted-foreground',
        status === 'saved' && 'text-green-500',
        status === 'error' && 'text-destructive',
      )}>
        {status === 'saving' ? 'Saving...' : status === 'saved' ? 'Saved' : 'Failed to save'}
      </Text>
    </View>
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
