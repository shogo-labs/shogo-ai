// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Phone and narrow-web chrome for Workspace Agent Chat. Desktop owns the
 * rail/context/inspector composition; this shell deliberately keeps one
 * focused transcript with a session drawer trigger and compact workspace
 * identity.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Menu } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { api } from '../../lib/api'
import { NotificationBell } from '../notifications/NotificationBell'
import { NativePhoneSheet } from '../phone/NativePhoneSheet'
import { NATIVE_PHONE_HEADER_ICON_SIZE, useNativePhoneIconChrome } from '../../lib/native-phone-layout'

interface MobileWorkspaceShellProps {
  children: ReactNode
}

export function MobileWorkspaceShell({
  children,
}: MobileWorkspaceShellProps) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const icon = useNativePhoneIconChrome()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessions, setSessions] = useState<Array<{
    id: string
    name?: string | null
    inferredName?: string | null
    isPrimary?: boolean
  }>>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const workspaceName = (workspace as any)?.name
    || (experience.kind === 'personal' ? 'Personal workspace' : 'Workspace')
  const filteredSessions = sessions.filter((session) => {
    const label = session.name || session.inferredName || 'Untitled side chat'
    return label.toLowerCase().includes(sessionSearch.trim().toLowerCase())
  })

  useEffect(() => {
    if (!sessionsOpen || !workspace?.id) return
    let cancelled = false
    setLoadingSessions(true)
    void api.listWorkspaceSessions(http, workspace.id)
      .then((next) => {
        if (!cancelled) setSessions(next)
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false)
      })
    return () => { cancelled = true }
  }, [http, sessionsOpen, workspace?.id])

  const createSideChat = async () => {
    if (!workspace?.id || creatingSession) return
    try {
      setCreatingSession(true)
      const session = await api.createWorkspaceSession(http, workspace.id)
      setSessions((current) => [...current, session])
      setSessionsOpen(false)
      router.push({ pathname: '/(app)/side-chats/[id]', params: { id: session.id } } as any)
    } finally {
      setCreatingSession(false)
    }
  }

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center border-b border-border/70 bg-card/90 px-3 pb-2"
        style={{ paddingTop: insets.top + 8 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sessionsOpen ? 'Close chat sessions' : 'Open chat sessions'}
          accessibilityState={{ expanded: sessionsOpen }}
          onPress={() => setSessionsOpen((open) => !open)}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
        >
          <Menu size={NATIVE_PHONE_HEADER_ICON_SIZE} color={icon.color} strokeWidth={icon.strokeWidth} />
        </Pressable>
        <View className="min-w-0 flex-1 px-2">
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {workspaceName}
          </Text>
          <Text className="text-xs text-muted-foreground">Workspace Agent Chat</Text>
        </View>
        <NotificationBell size={NATIVE_PHONE_HEADER_ICON_SIZE} />
      </View>
      <View className="min-h-0 flex-1">{children}</View>
      <NativePhoneSheet
        visible={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        title="Chats"
        subtitle="Main chat and side chats"
        scroll
        draggable
        keyboardBehavior="scroll"
      >
        <View className="gap-2 px-4 pb-6 pt-2">
          <TextInput
            value={sessionSearch}
            onChangeText={setSessionSearch}
            placeholder="Search chats"
            placeholderTextColor="#8a8a8f"
            accessibilityLabel="Search chats"
            className="h-11 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
          />
          {loadingSessions ? <Text className="py-3 text-sm text-muted-foreground">Loading chats…</Text> : null}
          {sessions.filter((session) => session.isPrimary).map((session) => (
            <Pressable
              key={session.id}
              onPress={() => {
                setSessionsOpen(false)
                router.replace('/(app)' as any)
              }}
              className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-3 active:opacity-80"
            >
              <Text className="text-sm font-semibold text-foreground">Main chat</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
                {session.name || session.inferredName || 'Workspace Agent Chat'}
              </Text>
            </Pressable>
          ))}
          <Text className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Side chats</Text>
          {filteredSessions.filter((session) => !session.isPrimary).map((session) => (
            <Pressable
              key={session.id}
              onPress={() => {
                setSessionsOpen(false)
                router.push({ pathname: '/(app)/side-chats/[id]', params: { id: session.id } } as any)
              }}
              className="rounded-xl border border-border bg-background px-3 py-3 active:bg-muted"
            >
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {session.name || session.inferredName || 'Untitled side chat'}
              </Text>
            </Pressable>
          ))}
          {!loadingSessions && filteredSessions.filter((session) => !session.isPrimary).length === 0 ? (
            <Text className="py-2 text-sm text-muted-foreground">No side chats yet.</Text>
          ) : null}
          <Pressable
            disabled={creatingSession}
            onPress={() => void createSideChat()}
            className="mt-2 items-center rounded-xl bg-primary px-3 py-3 active:opacity-85 disabled:opacity-50"
          >
            <Text className="text-sm font-semibold text-primary-foreground">
              {creatingSession ? 'Creating…' : 'New side chat'}
            </Text>
          </Pressable>
        </View>
      </NativePhoneSheet>
    </View>
  )
}
