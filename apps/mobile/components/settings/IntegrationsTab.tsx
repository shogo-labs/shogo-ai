// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Integrations tab.
 *
 * Workspace-level view of every Composio OAuth connection. Lets the
 * user see what's connected, disconnect, reconnect, or browse + add a
 * new toolkit without going through an agent.
 *
 * Only meaningful for workspaces with `composioScope === 'workspace'`
 * (the new default — see prisma/schema.prisma `Workspace.composioScope`
 * and packages/agent-runtime/src/composio.ts). For project-scoped
 * workspaces the workspace-level API returns 400 and we render a
 * help card pointing the user to per-project integration management.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
  TextInput,
} from 'react-native'
import * as ExpoLinking from 'expo-linking'
import {
  Globe,
  RefreshCw,
  LogOut,
  ExternalLink,
  Loader2,
  X,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { api, API_URL } from '../../lib/api'
import { openAuthFlow, preCreateAuthWindow, isMobileWeb } from '@shogo/ui-kit/platform'
import {
  Card,
  CardContent,
  Button,
  Badge,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'

const LOG_PREFIX = '[IntegrationsTab]'

interface Connection {
  id: string
  toolkit: string
  status: string
  statusReason?: string | null
  createdAt?: string
  accountIdentifier?: string | null
}

interface Provider {
  toolkit: string
  name: string
  whiteLabeled?: boolean
}

/** Friendly display labels + emoji icons for the toolkits we care about
 * most. Anything not listed falls back to the raw slug, title-cased. */
const TOOLKIT_DISPLAY: Record<string, { label: string; icon: string }> = {
  gmail: { label: 'Gmail', icon: '📧' },
  googlecalendar: { label: 'Google Calendar', icon: '📅' },
  googledrive: { label: 'Google Drive', icon: '📁' },
  googledocs: { label: 'Google Docs', icon: '📄' },
  googlesheets: { label: 'Google Sheets', icon: '📊' },
  slack: { label: 'Slack', icon: '💬' },
  discord: { label: 'Discord', icon: '🎮' },
  github: { label: 'GitHub', icon: '🐙' },
  gitlab: { label: 'GitLab', icon: '🦊' },
  linear: { label: 'Linear', icon: '📐' },
  jira: { label: 'Jira', icon: '🧭' },
  asana: { label: 'Asana', icon: '✅' },
  clickup: { label: 'ClickUp', icon: '🟪' },
  notion: { label: 'Notion', icon: '📝' },
  hubspot: { label: 'HubSpot', icon: '🟧' },
  salesforce: { label: 'Salesforce', icon: '☁️' },
  stripe: { label: 'Stripe', icon: '💳' },
  twilio: { label: 'Twilio', icon: '📞' },
  elevenlabs: { label: 'ElevenLabs', icon: '🎙️' },
  zendesk: { label: 'Zendesk', icon: '🎫' },
  freshdesk: { label: 'Freshdesk', icon: '🎟️' },
  sentry: { label: 'Sentry', icon: '⚠️' },
  airbnb: { label: 'Airbnb', icon: '🏠' },
  metaads: { label: 'Meta Ads', icon: '📣' },
  googleads: { label: 'Google Ads', icon: '🎯' },
  calendly: { label: 'Calendly', icon: '🗓️' },
}

function getToolkitDisplay(toolkit: string) {
  const key = toolkit.toLowerCase().replace(/[-_\s]/g, '')
  return (
    TOOLKIT_DISPLAY[key] ?? {
      label: toolkit.charAt(0).toUpperCase() + toolkit.slice(1),
      icon: '🔗',
    }
  )
}

export function IntegrationsTab() {
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id

  const [connections, setConnections] = useState<Connection[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [providersEnabled, setProvidersEnabled] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [providersLoading, setProvidersLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `'unsupported'` means the workspace is on `composioScope='project'`,
  // which makes a workspace-level view meaningless.
  const [scopeError, setScopeError] = useState<'unsupported' | null>(null)
  const [busyToolkit, setBusyToolkit] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [showBrowse, setShowBrowse] = useState(false)
  const [browseQuery, setBrowseQuery] = useState('')

  const loadConnections = useCallback(async () => {
    if (!workspaceId) return
    setIsLoading(true)
    setError(null)
    setScopeError(null)
    try {
      const data = await api.getWorkspaceIntegrationConnections(http, workspaceId)
      setConnections(data as Connection[])
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? '')
      // The API returns this exact phrase when the workspace is
      // configured for project-scoped Composio IDs.
      if (msg.includes('composioScope="workspace"')) {
        setScopeError('unsupported')
      } else {
        setError(msg)
      }
    } finally {
      setIsLoading(false)
    }
  }, [http, workspaceId])

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true)
    try {
      const { providers: list, enabled } = await api.getIntegrationProviders(http)
      setProviders(list)
      setProvidersEnabled(enabled)
    } catch (err: any) {
      console.warn(LOG_PREFIX, 'Failed to load providers', err)
    } finally {
      setProvidersLoading(false)
    }
  }, [http])

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  useEffect(() => {
    if (showBrowse && providers.length === 0 && !providersLoading) {
      loadProviders()
    }
  }, [showBrowse, providers.length, providersLoading, loadProviders])

  const connectedSlugs = useMemo(
    () =>
      new Set(
        connections
          .filter((c) => c.status?.toLowerCase() === 'active')
          .map((c) => c.toolkit?.toLowerCase()),
      ),
    [connections],
  )

  const handleConnect = useCallback(
    async (toolkit: string) => {
      if (!workspaceId) return
      setBusyToolkit(toolkit)
      setError(null)

      const preWindow = Platform.OS === 'web' ? preCreateAuthWindow() : null

      try {
        const isNative = Platform.OS !== 'web'
        let redirect: string | undefined
        if (isNative) {
          redirect = ExpoLinking.createURL('integrations-callback')
        } else if (isMobileWeb()) {
          const returnUrl = new URL(window.location.href)
          returnUrl.searchParams.set('fromOAuth', '1')
          redirect = returnUrl.toString()
        }

        const callbackUrl = redirect
          ? `${API_URL}/api/integrations/callback?redirect=${encodeURIComponent(redirect)}`
          : `${API_URL}/api/integrations/callback`

        const result = await api.connectWorkspaceIntegration(
          http,
          toolkit,
          workspaceId,
          callbackUrl,
        )
        const redirectUrl = result.data?.redirectUrl
        if (!redirectUrl) {
          setError('No redirect URL received from Composio')
          setBusyToolkit(null)
          return
        }

        await openAuthFlow(redirectUrl, { preCreatedWindow: preWindow })
        // Give Composio a beat to register the webhook before refetching.
        await new Promise((r) => setTimeout(r, 1500))
        await loadConnections()
      } catch (err: any) {
        console.error(LOG_PREFIX, `Connect error for ${toolkit}:`, err)
        setError(err?.message ?? String(err))
      } finally {
        setBusyToolkit(null)
        try {
          if (preWindow && !preWindow.closed) {
            const loc = preWindow.location.href
            if (loc === 'about:blank' || loc === '') preWindow.close()
          }
        } catch {
          /* COOP — ignore */
        }
      }
    },
    [http, workspaceId, loadConnections],
  )

  const handleDisconnect = useCallback(
    async (connectionId: string) => {
      setDisconnecting(connectionId)
      setError(null)
      try {
        await api.disconnectIntegration(http, connectionId)
        await loadConnections()
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setDisconnecting(null)
      }
    },
    [http, loadConnections],
  )

  const filteredProviders = useMemo(() => {
    const q = browseQuery.trim().toLowerCase()
    if (!q) return providers
    return providers.filter(
      (p) =>
        p.toolkit.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
    )
  }, [providers, browseQuery])

  const activeConnections = connections.filter(
    (c) => c.status?.toLowerCase() === 'active',
  )
  const inactiveConnections = connections.filter(
    (c) => c.status?.toLowerCase() !== 'active',
  )

  // Header is rendered at the page level by SettingsPage; this tab
  // returns the body content.
  return (
    <View className="gap-6 pb-12">
      <View>
        <Text className="text-2xl font-semibold text-foreground">Integrations</Text>
        <Text className="text-sm text-muted-foreground mt-1">
          OAuth connections shared across every project in this workspace.
          Connect once here and your agents pick them up automatically.
        </Text>
      </View>

      {scopeError === 'unsupported' ? (
        <Card>
          <CardContent className="p-5 gap-3">
            <View className="flex-row items-start gap-3">
              <AlertCircle size={18} className="text-amber-500 mt-0.5" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  Workspace-level integrations are turned off
                </Text>
                <Text className="text-sm text-muted-foreground mt-1">
                  This workspace is configured for project-scoped Composio
                  connections, so each project authenticates its own copy.
                  Open any project and use the Connect button surfaced by
                  the agent (or the in-project Services panel) to manage
                  integrations there.
                </Text>
                <Text className="text-xs text-muted-foreground mt-2 font-mono">
                  composioScope = "project"
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>
      ) : (
        <>
          {error && (
            <Card>
              <CardContent className="p-3 flex-row items-center gap-2">
                <AlertCircle size={16} className="text-destructive" />
                <Text className="text-xs text-destructive flex-1">{error}</Text>
                <Pressable onPress={() => setError(null)} className="p-1">
                  <X size={12} className="text-destructive" />
                </Pressable>
              </CardContent>
            </Card>
          )}

          <View className="flex-row items-center gap-3">
            <Text className="text-sm font-medium text-foreground">
              {activeConnections.length} connected
            </Text>
            {inactiveConnections.length > 0 && (
              <Badge variant="secondary">
                {inactiveConnections.length} inactive
              </Badge>
            )}
            <View className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onPress={loadConnections}
              disabled={isLoading}
            >
              <View className="flex-row items-center gap-1.5">
                <RefreshCw size={14} className="text-foreground" />
                <Text className="text-sm text-foreground">Refresh</Text>
              </View>
            </Button>
            <Button
              size="sm"
              onPress={() => setShowBrowse((v) => !v)}
              disabled={!providersEnabled && providers.length === 0}
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={14} className="text-primary-foreground" />
                <Text className="text-sm text-primary-foreground">
                  {showBrowse ? 'Hide catalog' : 'Add integration'}
                </Text>
              </View>
            </Button>
          </View>

          {/* Connected list */}
          {isLoading ? (
            <View className="gap-2">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </View>
          ) : activeConnections.length === 0 && inactiveConnections.length === 0 ? (
            <Card>
              <CardContent className="p-8 items-center">
                <Globe size={28} className="text-muted-foreground mb-3" />
                <Text className="text-sm font-medium text-foreground">
                  No services connected yet
                </Text>
                <Text className="text-xs text-muted-foreground mt-1 text-center max-w-md">
                  Click <Text className="font-medium">Add integration</Text> to
                  browse Gmail, Stripe, Slack and ~250 other toolkits — or
                  let an agent prompt you the next time it needs one.
                </Text>
              </CardContent>
            </Card>
          ) : (
            <View className="gap-2">
              {[...activeConnections, ...inactiveConnections].map((conn) => {
                const display = getToolkitDisplay(conn.toolkit)
                const isActive = conn.status?.toLowerCase() === 'active'
                const isDisconnecting = disconnecting === conn.id
                const isReconnecting = busyToolkit === conn.toolkit

                return (
                  <Card key={conn.id}>
                    <CardContent className="p-3">
                      <View className="flex-row items-center gap-3">
                        <View className="w-10 h-10 rounded-md bg-muted items-center justify-center">
                          <Text className="text-lg">{display.icon}</Text>
                        </View>

                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <Text className="text-sm font-medium text-foreground">
                              {display.label}
                            </Text>
                            {isActive ? (
                              <View className="flex-row items-center gap-1">
                                <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                <Text className="text-[10px] text-muted-foreground uppercase tracking-wide">
                                  Active
                                </Text>
                              </View>
                            ) : (
                              <Badge variant="secondary">
                                {conn.status?.toLowerCase() ?? 'inactive'}
                              </Badge>
                            )}
                          </View>
                          <Text
                            className="text-xs text-muted-foreground mt-0.5"
                            numberOfLines={1}
                          >
                            {conn.accountIdentifier ??
                              conn.statusReason ??
                              (isActive ? 'Connected' : 'Not connected')}
                          </Text>
                        </View>

                        <View className="flex-row items-center gap-1">
                          <Pressable
                            onPress={() => handleConnect(conn.toolkit)}
                            disabled={isReconnecting || isDisconnecting}
                            className={cn(
                              'p-2 rounded-md active:bg-muted',
                              (isReconnecting || isDisconnecting) && 'opacity-50',
                            )}
                            accessibilityLabel={isActive ? 'Reconnect' : 'Connect'}
                          >
                            {isReconnecting ? (
                              <Loader2 size={14} className="text-muted-foreground" />
                            ) : (
                              <ExternalLink size={14} className="text-muted-foreground" />
                            )}
                          </Pressable>
                          <Pressable
                            onPress={() => handleDisconnect(conn.id)}
                            disabled={isDisconnecting || isReconnecting}
                            className={cn(
                              'p-2 rounded-md active:bg-destructive/10',
                              (isDisconnecting || isReconnecting) && 'opacity-50',
                            )}
                            accessibilityLabel="Disconnect"
                          >
                            {isDisconnecting ? (
                              <ActivityIndicator size="small" />
                            ) : (
                              <LogOut size={14} className="text-muted-foreground" />
                            )}
                          </Pressable>
                        </View>
                      </View>
                    </CardContent>
                  </Card>
                )
              })}
            </View>
          )}

          {/* Browse / add integration */}
          {showBrowse && (
            <View className="gap-3">
              <View className="flex-row items-center gap-2">
                <Text className="text-base font-medium text-foreground flex-1">
                  Browse catalog
                </Text>
                {providersLoading && (
                  <ActivityIndicator size="small" />
                )}
              </View>

              <View className="flex-row items-center gap-2 px-3 py-2 rounded-md border border-border">
                <Search size={14} className="text-muted-foreground" />
                <TextInput
                  className="flex-1 text-sm text-foreground"
                  style={{ outlineStyle: 'none' } as any}
                  placeholder="Search Gmail, Stripe, Slack…"
                  placeholderTextColor="rgb(115 115 115)"
                  value={browseQuery}
                  onChangeText={setBrowseQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {browseQuery.length > 0 && (
                  <Pressable onPress={() => setBrowseQuery('')} className="p-1">
                    <X size={12} className="text-muted-foreground" />
                  </Pressable>
                )}
              </View>

              {!providersEnabled ? (
                <Card>
                  <CardContent className="p-4">
                    <Text className="text-sm text-muted-foreground">
                      Composio isn't configured for this server. Set{' '}
                      <Text className="font-mono text-xs">COMPOSIO_API_KEY</Text>{' '}
                      in the API env to enable third-party integrations.
                    </Text>
                  </CardContent>
                </Card>
              ) : filteredProviders.length === 0 && !providersLoading ? (
                <Card>
                  <CardContent className="p-4">
                    <Text className="text-sm text-muted-foreground">
                      {browseQuery
                        ? `No toolkits match "${browseQuery}".`
                        : 'No toolkits available.'}
                    </Text>
                  </CardContent>
                </Card>
              ) : (
                <ScrollView
                  className="max-h-[480px]"
                  showsVerticalScrollIndicator
                >
                  <View className="gap-1.5">
                    {filteredProviders.map((p) => {
                      const display = getToolkitDisplay(p.toolkit)
                      const isConnected = connectedSlugs.has(p.toolkit.toLowerCase())
                      const isBusy = busyToolkit === p.toolkit
                      return (
                        <View
                          key={p.toolkit}
                          className="flex-row items-center gap-3 px-3 py-2.5 rounded-md border border-border"
                        >
                          <View className="w-8 h-8 rounded bg-muted items-center justify-center">
                            <Text className="text-base">{display.icon}</Text>
                          </View>
                          <View className="flex-1">
                            <Text className="text-sm font-medium text-foreground">
                              {p.name || display.label}
                            </Text>
                            <Text className="text-[11px] text-muted-foreground font-mono">
                              {p.toolkit}
                            </Text>
                          </View>
                          {isConnected ? (
                            <View className="flex-row items-center gap-1 px-2 py-1">
                              <CheckCircle2 size={14} className="text-green-500" />
                              <Text className="text-xs text-muted-foreground">
                                Connected
                              </Text>
                            </View>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onPress={() => handleConnect(p.toolkit)}
                              disabled={isBusy}
                            >
                              {isBusy ? (
                                <View className="flex-row items-center gap-1.5">
                                  <Loader2 size={12} className="text-foreground" />
                                  <Text className="text-xs text-foreground">
                                    Opening…
                                  </Text>
                                </View>
                              ) : (
                                <Text className="text-xs text-foreground">Connect</Text>
                              )}
                            </Button>
                          )}
                        </View>
                      )
                    })}
                  </View>
                </ScrollView>
              )}
            </View>
          )}
        </>
      )}
    </View>
  )
}
