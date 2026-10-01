// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace setting for where team chat lives: off, Shogo's own channels, or
 * an external chat app (Slack, Teams, Google Chat) where agents join your
 * existing channels.
 */
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { Button, Card, CardContent, cn } from '@shogo/shared-ui/primitives'
import { Text } from '../settings/account-sheet-chrome'
import { useWorkspaceChatMode } from '../../hooks/useWorkspaceChatMode'
import { teamChatApi, type ChatModeValue, type ExternalChatProvider } from '../../lib/team-chat-api'
import { isLocalMode } from '../../lib/platform-config'
import { isCloudWorkspace } from '../../lib/workspace-route'

const api = teamChatApi()

/** Apps without an OAuth install: an admin sends `@Shogo connect <code>` from the app instead. */
const CODE_CONNECT: Array<{ provider: ExternalChatProvider; label: string; hint: string }> = [
  { provider: 'teams', label: 'Microsoft Teams', hint: 'Add the Shogo app to a team or chat, then send it this message:' },
  { provider: 'google_chat', label: 'Google Chat', hint: 'Add the Shogo app to a space or DM it, then send it this message:' },
]

interface Option {
  id: string
  mode: ChatModeValue
  provider: ExternalChatProvider | null
  label: string
  description: string
}

const OPTIONS: Option[] = [
  { id: 'native', mode: 'native', provider: null, label: 'Shogo chat', description: 'Channels, DMs, and threads inside Shogo, with agents as teammates.' },
  { id: 'slack', mode: 'external', provider: 'slack', label: 'Slack', description: 'Agents join your Slack channels. Shogo chat is hidden.' },
  { id: 'teams', mode: 'external', provider: 'teams', label: 'Microsoft Teams', description: 'Agents join your Teams channels. Shogo chat is hidden.' },
  { id: 'google_chat', mode: 'external', provider: 'google_chat', label: 'Google Chat', description: 'Agents join your Google Chat spaces. Shogo chat is hidden.' },
  { id: 'off', mode: 'off', provider: null, label: 'Off', description: 'No team chat. Use agents from project and workspace chat.' },
]

/**
 * A desktop-only workspace has no public webhook endpoint for Slack, Teams or
 * Google Chat to call, and nobody else can join it.
 */
const LOCAL_OPTIONS: Option[] = [
  { id: 'native', mode: 'native', provider: null, label: 'Shogo chat', description: 'Channels, DMs, and threads on this computer only, with agents as teammates.' },
  OPTIONS[OPTIONS.length - 1]!,
]

function selectedId(mode: ChatModeValue | undefined, provider: ExternalChatProvider | null | undefined): string | null {
  if (!mode) return null
  if (mode === 'external' || mode === 'bridged') return provider ?? null
  return mode
}

export function TeamChatModeCard({ workspaceId }: { workspaceId: string }) {
  const { config, loading, update, refresh } = useWorkspaceChatMode(workspaceId)
  const [codes, setCodes] = useState<Partial<Record<ExternalChatProvider, string>>>({})
  const installedProviders = config?.installations.map((i) => i.provider)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = selectedId(config?.mode, config?.provider)
  const canManage = !!config?.canManage
  const onThisComputer = isLocalMode() && !isCloudWorkspace(workspaceId)
  const options = onThisComputer ? LOCAL_OPTIONS : OPTIONS

  const choose = async (option: Option) => {
    if (!canManage || option.id === current) return
    setSaving(option.id)
    setError(null)
    try {
      await update(option.mode, option.provider)
    } catch (err: any) {
      setError(err?.message ?? 'Could not change team chat')
    } finally {
      setSaving(null)
    }
  }

  const getCode = async (provider: ExternalChatProvider) => {
    setError(null)
    try {
      const { command } = await api.chatConnectCode(workspaceId, provider)
      setCodes((prev) => ({ ...prev, [provider]: command }))
    } catch (err: any) {
      setError(err?.message ?? 'Could not create a connect code')
    }
  }

  const disconnect = async (provider: ExternalChatProvider) => {
    setError(null)
    try {
      await api.disconnectChatProvider(workspaceId, provider)
      setCodes((prev) => ({ ...prev, [provider]: undefined }))
      await refresh()
    } catch (err: any) {
      setError(err?.message ?? 'Could not disconnect')
    }
  }

  return (
    <Card>
      <CardContent className="p-3">
        <Text className="text-sm font-medium text-foreground">Team chat</Text>
        <Text className="text-xs text-muted-foreground mt-0.5">
          {loading
            ? 'Loading…'
            : canManage
              ? 'Choose where your team talks with each other and with agents.'
              : 'Only workspace admins can change where team chat lives.'}
        </Text>
        <View className="mt-3 gap-1.5">
          {options.map((option) => {
            const active = option.id === current
            const needsInstall = !!option.provider && installedProviders !== undefined && !installedProviders.includes(option.provider)
            const tenant = option.provider ? config?.installations.find((i) => i.provider === option.provider)?.tenantName : null
            const disabled = !canManage || needsInstall || saving !== null
            return (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: active, disabled }}
                accessibilityLabel={option.label}
                disabled={disabled}
                onPress={() => void choose(option)}
                className={cn(
                  'flex-row items-start gap-3 rounded-md border px-3 py-2',
                  active ? 'border-primary bg-primary/5' : 'border-border active:bg-muted',
                  disabled && !active && 'opacity-60',
                )}
              >
                <View className={cn('mt-0.5 h-3.5 w-3.5 rounded-full border', active ? 'border-primary bg-primary' : 'border-border')} />
                <View className="flex-1">
                  <Text className="text-sm text-foreground">
                    {option.label}
                    {saving === option.id ? '  Saving…' : ''}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    {needsInstall
                      ? `Connect ${option.label} below first.`
                      : tenant ? `${option.description} Connected to ${tenant}.` : option.description}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </View>
        {canManage && !onThisComputer ? (
          <View className="mt-3 gap-2">
            {CODE_CONNECT.map(({ provider, label, hint }) => {
              const installed = config?.installations.find((i) => i.provider === provider)
              const command = codes[provider]
              return (
                <View key={provider} className="rounded-md border border-border px-3 py-2">
                  <View className="flex-row items-center justify-between gap-2">
                    <Text className="text-xs text-foreground">
                      {label}
                      {installed ? ` · Connected${installed.tenantName ? ` to ${installed.tenantName}` : ''}` : ''}
                    </Text>
                    {installed ? (
                      <Button size="sm" variant="ghost" onPress={() => void disconnect(provider)}>Disconnect</Button>
                    ) : command ? (
                      <Button size="sm" variant="ghost" onPress={() => void refresh()}>Check again</Button>
                    ) : (
                      <Button size="sm" variant="outline" onPress={() => void getCode(provider)}>Connect</Button>
                    )}
                  </View>
                  {!installed && command ? (
                    <View className="mt-1.5 gap-1">
                      <Text className="text-[11px] text-muted-foreground">{hint}</Text>
                      <Text selectable className="text-[11px] font-mono text-foreground">{command}</Text>
                      <Text className="text-[11px] text-muted-foreground">The code expires in 30 minutes.</Text>
                    </View>
                  ) : null}
                </View>
              )
            })}
          </View>
        ) : null}
        {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
      </CardContent>
    </Card>
  )
}
