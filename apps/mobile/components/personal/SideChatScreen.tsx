// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A single side chat: the same workspace-scoped `ChatPanel` the primary
 * companion chat uses (same merged-root runtime, same tools), just pointed
 * at a non-primary `ChatSession`. See `SideChatsScreen` for the list this
 * is opened from.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { observer } from "mobx-react-lite"
import { useAuth } from "../../contexts/auth"
import { useDomainHttp } from "../../contexts/domain"
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace"
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience"
import { api, type PersonalAgentProfile } from "../../lib/api"
import { ChatPanel } from "../chat/ChatPanel"
import type { RestoreDraftRequest } from "../chat/ChatInput"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"
import { BuddyLookSheet } from "./BuddyLookSheet"
import { PersonalAgentMobileHeader } from "./PersonalAgentMobileHeader"
import { buildDefaultProfileActions } from "./ProfileActionMenu"
import type { BuddyState } from "../island/buddy/engine"

export const SideChatScreen = observer(function SideChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
  // Legacy native routes do not mount MobileWorkspaceShell, but side chats
  // should still use its floating companion chrome instead of an in-flow
  // route-title header.
  const useFloatingAgentChrome =
    usesMobileWorkspaceChrome || Platform.OS !== "web"
  const workspaceId = workspace?.id
  const [profile, setProfile] = useState<PersonalAgentProfile | null>(null)
  const [prefillRequest, setPrefillRequest] =
    useState<RestoreDraftRequest | null>(null)
  const [buddyLookSheetOpen, setBuddyLookSheetOpen] = useState(false)
  const [avatarState, setAvatarState] = useState<BuddyState>("idle")
  const avatarFinishedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const avatarStreaming = useRef(false)

  const handleStreamingChange = useCallback((isStreaming: boolean) => {
    if (avatarFinishedTimer.current) clearTimeout(avatarFinishedTimer.current)
    if (isStreaming) {
      avatarStreaming.current = true
      setAvatarState("working")
      return
    }
    if (!avatarStreaming.current) {
      setAvatarState("idle")
      return
    }
    avatarStreaming.current = false
    setAvatarState("finished")
    avatarFinishedTimer.current = setTimeout(() => {
      avatarFinishedTimer.current = null
      setAvatarState("idle")
    }, 1800)
  }, [])

  useEffect(() => {
    avatarStreaming.current = false
    setAvatarState("idle")
    if (avatarFinishedTimer.current) {
      clearTimeout(avatarFinishedTimer.current)
      avatarFinishedTimer.current = null
    }
    if (!workspaceId) {
      setProfile(null)
      return
    }
    let cancelled = false
    setProfile(null)
    void api
      .getAgentProfile(http, workspaceId)
      .then((nextProfile) => {
        if (!cancelled) setProfile(nextProfile)
      })
      .catch(() => {
        if (!cancelled) setProfile(null)
      })
    return () => {
      cancelled = true
    }
  }, [http, workspaceId])

  useEffect(
    () => () => {
      if (avatarFinishedTimer.current) clearTimeout(avatarFinishedTimer.current)
    },
    [],
  )

  if (!workspaceId || !id) return null

  const profileActions = profile
    ? buildDefaultProfileActions({
        agentName: profile.name,
        onPrefill: (content) =>
          setPrefillRequest({ nonce: Date.now(), content }),
        onCustomizeAvatar: () => setBuddyLookSheetOpen(true),
        onOpenActivity: () => router.push("/(app)/activity" as any),
        onOpenSideChats: () => router.push("/(app)/side-chats" as any),
      })
    : []

  return (
    <View className="flex-1 bg-background">
      {useFloatingAgentChrome && profile ? (
        <PersonalAgentMobileHeader
          profile={profile}
          actions={profileActions}
          avatarState={avatarState}
        />
      ) : null}
      <View className="min-h-0 flex-1">
        <ChatPanel
          featureId={null}
          featureName="Side chat"
          phase={null}
          workspaceId={workspaceId}
          userId={user?.id}
          chatScope="workspace"
          chatSessionId={id}
          onChatSessionChange={() => {}}
          onStreamingChange={handleStreamingChange}
          composer={experience.composer}
          presentation="agent"
          prefillRequest={prefillRequest}
          onPrefillConsumed={(nonce) =>
            setPrefillRequest((current) =>
              current?.nonce === nonce ? null : current,
            )
          }
          className="flex-1"
          isActive
          // The floating profile intentionally overlaps the transcript like
          // the primary Mina chat. Keep the normal chrome inset so the first
          // message is not pushed down by a second header-sized gap.
          phoneTranscriptTopPadding="chrome"
        />
      </View>
      <BuddyLookSheet visible={buddyLookSheetOpen} onClose={() => setBuddyLookSheetOpen(false)} />
    </View>
  )
})
