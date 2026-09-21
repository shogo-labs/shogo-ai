// SPDX-License-Identifier: MIT
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
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
  Linking,
} from 'react-native'
import * as ExpoLinking from 'expo-linking'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Globe as GlobeIcon,
  RefreshCw as RefreshCwIcon,
  LogOut as LogOutIcon,
  ExternalLink as ExternalLinkIcon,
  Loader2 as Loader2Icon,
  X as XIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  CheckCircle2 as CheckCircle2Icon,
  AlertCircle as AlertCircleIcon,
} from 'lucide-react-native'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { useAuth } from '../../contexts/auth'
import { api, API_URL } from '../../lib/api'
import { openAuthFlow, preCreateAuthWindow } from '@shogo/ui-kit/platform'
import { SlackProjectsModal, type SlackProjectRow } from './SlackProjectsModal'
import {
  Card,
  CardContent,
  Button,
  Badge,
  Skeleton,
  cn,
} from '@shogo/shared-ui/primitives'
import {
  Text,
  TextInput,
  useAccountSheetIcons,
} from './account-sheet-chrome'

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
  const {
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
  } = useAccountSheetIcons({
    Globe: GlobeIcon,
    RefreshCw: RefreshCwIcon,
    LogOut: LogOutIcon,
    ExternalLink: ExternalLinkIcon,
    Loader2: Loader2Icon,
    X: XIcon,
    Plus: PlusIcon,
    Search: SearchIcon,
    CheckCircle2: CheckCircle2Icon,
    AlertCircle: AlertCircleIcon,
  })
  const http = useDomainHttp()
  const router = useRouter()
  // `slackLinked=1` is appended by the `/auth/slack-link` bridge page right
  // after it finishes linking a Slack account, so this tab can pop open the
  // project manager with a success banner instead of the user landing on an
  // unchanged-looking settings page and wondering if anything happened.
  const searchParams = useLocalSearchParams<{ slackLinked?: string }>()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { user } = useAuth()
  const currentUserId = user?.id

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

  // ── Shogo Agent for Slack (workspace-level install, separate from the
  // Composio "Slack" OAuth toolkit listed below) ──────────────────────
  const [slackAgentConfig, setSlackAgentConfig] = useState<{
    installed: boolean
    installation?: { slackTeamId: string; slackTeamName?: string | null } | null
    projects: SlackProjectRow[]
  } | null>(null)
  const [slackAgentLoading, setSlackAgentLoading] = useState(false)
  const [slackProjectSaving, setSlackProjectSaving] = useState<string | null>(null)
  const [slackBulkSaving, setSlackBulkSaving] = useState(false)
  const [slackManageOpen, setSlackManageOpen] = useState(false)
  const [slackJustLinked, setSlackJustLinked] = useState(false)

  const loadSlackAgentConfig = useCallback(async () => {
    if (!workspaceId) return
    setSlackAgentLoading(true)
    try {
      const data = await api.getSlackAgentConfig(http, workspaceId)
      setSlackAgentConfig(data)
    } catch (err: any) {
      console.warn(LOG_PREFIX, 'Failed to load Slack Agent config', err)
      setSlackAgentConfig(null)
    } finally {
      setSlackAgentLoading(false)
    }
  }, [http, workspaceId])

  useEffect(() => {
    loadSlackAgentConfig()
  }, [loadSlackAgentConfig])

  // React to `?slackLinked=1` (see the comment on `searchParams` above).
  // Waits for `slackAgentConfig` to actually load — opening the modal a
  // beat before `installed`/`projects` are known would just show an empty
  // list — then opens the project manager with the success banner, and
  // strips the query param so a refresh or back-navigation doesn't
  // re-trigger it.
  useEffect(() => {
    if (searchParams.slackLinked !== '1') return
    if (slackAgentLoading || !slackAgentConfig?.installed) return
    setSlackJustLinked(true)
    setSlackManageOpen(true)
    router.setParams({ slackLinked: undefined } as any)
  }, [searchParams.slackLinked, slackAgentLoading, slackAgentConfig, router])

  const toggleSlackProject = useCallback(
    async (projectId: string, enabled: boolean) => {
      if (!workspaceId) return
      setSlackProjectSaving(projectId)
      try {
        await api.setSlackAgentProjectEnabled(http, workspaceId, projectId, enabled)
        setSlackAgentConfig((prev) =>
          prev
            ? {
                ...prev,
                projects: prev.projects.map((p) =>
                  p.id === projectId ? { ...p, slackEnabled: enabled } : p,
                ),
              }
            : prev,
        )
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setSlackProjectSaving(null)
      }
    },
    [http, workspaceId],
  )

  const bulkToggleSlackProjects = useCallback(
    async (projectIds: string[], enabled: boolean) => {
      if (!workspaceId || projectIds.length === 0) return
      setSlackBulkSaving(true)
      try {
        await api.setSlackAgentProjectsEnabled(http, workspaceId, projectIds, enabled)
        const ids = new Set(projectIds)
        setSlackAgentConfig((prev) =>
          prev
            ? {
                ...prev,
                projects: prev.projects.map((p) =>
                  ids.has(p.id) ? { ...p, slackEnabled: enabled } : p,
                ),
              }
            : prev,
        )
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setSlackBulkSaving(false)
      }
    },
    [http, workspaceId],
  )

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
        } else {
          // Web (desktop browser, mobile web, Electron): always pass our own
          // URL so the OAuth callback returns here. See ConnectToolWidget.tsx
          // for the rationale on why every web client must opt in.
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
        await api.disconnectIntegration(http, connectionId, { workspaceId })
        await loadConnections()
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setDisconnecting(null)
      }
    },
    [http, workspaceId, loadConnections],
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

      {/* Shogo Agent for Slack — a single workspace-level install, kept
          separate from the Composio OAuth list below since it's Slack's
          native Agents platform (DM/mention the bot), not a per-tool
          OAuth grant an agent uses to call the Slack API. */}
      <Card>
        <CardContent className="p-3">
          <View className="flex-row items-center gap-3">
            <View className="w-10 h-10 rounded-md bg-muted items-center justify-center">
              <Text className="text-lg">🧠</Text>
            </View>
            <View className="flex-1">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-medium text-foreground">
                  Shogo Agent for Slack
                </Text>
                {slackAgentConfig?.installed && (
                  <View className="flex-row items-center gap-1">
                    <View className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <Text className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Active
                    </Text>
                  </View>
                )}
              </View>
              <Text className="text-xs text-muted-foreground mt-0.5">
                {slackAgentLoading
                  ? 'Loading…'
                  : slackAgentConfig?.installed
                    ? `Installed in ${slackAgentConfig.installation?.slackTeamName ?? 'your Slack workspace'}. DM or @mention it to route requests to any enabled project.`
                    : 'One workspace-level Shogo agent that can route Slack requests to any project you enable below.'}
              </Text>
            </View>
            {!slackAgentConfig?.installed && (
              <Pressable
                onPress={() =>
                  workspaceId &&
                  Linking.openURL(
                    `${API_URL}/api/integrations/slack/install?workspaceId=${encodeURIComponent(workspaceId)}`,
                  )
                }
                className="px-3 py-1.5 bg-primary rounded-md active:bg-primary/80"
              >
                <Text className="text-xs text-primary-foreground">Add to Slack</Text>
              </Pressable>
            )}
          </View>

          {slackAgentConfig?.installed && (
            <View className="mt-3 pt-3 border-t border-border">
              <View className="flex-row items-center gap-3">
                <View className="flex-1">
                  <Text className="text-xs text-foreground">
                    {slackAgentConfig.projects.filter((p) => p.slackEnabled).length} of{' '}
                    {slackAgentConfig.projects.length} project
                    {slackAgentConfig.projects.length === 1 ? '' : 's'} enabled
                  </Text>
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    New projects are Slack-enabled by default. In Slack, run{' '}
                    <Text className="font-mono text-foreground">@Shogo settings</Text> to set
                    personal or channel defaults.
                  </Text>
                </View>
                <Pressable
                  onPress={() => setSlackManageOpen(true)}
                  disabled={slackAgentConfig.projects.length === 0}
                  className="px-3 py-1.5 border border-border rounded-md active:bg-muted"
                >
                  <Text className="text-xs text-foreground">Manage projects</Text>
                </Pressable>
              </View>
            </View>
          )}
        </CardContent>
      </Card>

      {slackAgentConfig?.installed && (
        <SlackProjectsModal
          visible={slackManageOpen}
          onClose={() => {
            setSlackManageOpen(false)
            setSlackJustLinked(false)
          }}
          projects={slackAgentConfig.projects}
          currentUserId={currentUserId}
          onToggle={toggleSlackProject}
          onBulkToggle={bulkToggleSlackProjects}
          savingProjectId={slackProjectSaving}
          bulkSaving={slackBulkSaving}
          justLinked={slackJustLinked}
        />
      )}

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
