// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The workspace-scoped Agent Chat surface shared by personal and team
 * workspaces. It is the only root-route surface that creates or retrieves the
 * stable primary workspace session.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useRouter } from "expo-router"
import { observer } from "mobx-react-lite"
import { Sparkles, X } from "lucide-react-native"
import { useAuth } from "../../contexts/auth"
import {
  useDomainHttp,
  useMemberCollection,
  useProjectCollection,
  useWorkspaceCollection,
} from "../../contexts/domain"
import {
  GetStartedChecklist,
  useGettingStarted,
} from "../onboarding/GetStartedChecklist"
import { openInWorkspace } from "../../lib/switch-workspace"
import { pickTeamWorkspace } from "../../lib/team-workspace"
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace"
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience"
import { clearChatPrefill, useChatPrefill } from "../../hooks/useChatPrefill"
import { api, type PersonalAgentProfile } from "../../lib/api"
import { ChatPanel } from "../chat/ChatPanel"
import type { RestoreDraftRequest } from "../chat/ChatInput"
import { NativePhoneSheet } from "../phone/NativePhoneSheet"
import { PersonalAgentHeader } from "../personal/PersonalAgentHeader"
import { PersonalAgentMobileHeader } from "../personal/PersonalAgentMobileHeader"
import { useWelcomeMessage } from "../personal/useWelcomeMessage"
import { buildDefaultProfileActions } from "../personal/ProfileActionMenu"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"
import {
  publishPrimaryWorkspaceSession,
  publishWorkspaceSessionScopeChanged,
  subscribeWorkspaceSessionScopeChanged,
} from "./workspace-agent-session-bus"

export const WorkspaceAgentChatScreen = observer(
  function WorkspaceAgentChatScreen() {
    const router = useRouter()
    const { user } = useAuth()
    const http = useDomainHttp()
    const workspace = useActiveWorkspace()
    const projects = useProjectCollection()
    const experience = useWorkspaceExperience()
    const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
    const insets = useSafeAreaInsets()
    const [profile, setProfile] = useState<PersonalAgentProfile | null>(null)
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [prefillRequest, setPrefillRequest] =
      useState<RestoreDraftRequest | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attachments, setAttachments] = useState<
      Array<{
        id: string
        projectId: string
        attachMode: "readwrite" | "readonly"
      }>
    >([])
    const [focusedProjectId, setFocusedProjectId] = useState<string | null>(
      null,
    )
    const [scopeSheetOpen, setScopeSheetOpen] = useState(false)
    const [scopeBusyProjectId, setScopeBusyProjectId] = useState<string | null>(
      null,
    )
    const [scopeError, setScopeError] = useState<string | null>(null)
    const loadVersion = useRef(0)
    const crossTabPrefill = useChatPrefill()
    const { showWelcome, dismissWelcome } = useWelcomeMessage(workspace?.id)
    const isPersonalWorkspace = experience.kind === "personal"
    const gettingStarted = useGettingStarted()
    const workspaces = useWorkspaceCollection()
    const members = useMemberCollection()
    const teamWorkspaceId = pickTeamWorkspace(
      (workspaces?.all ?? []) as Array<{ id: string; kind?: string }>,
      (members?.all ?? []) as any[],
      user?.id,
    )?.id

    const loadWorkspaceChat = useCallback(async () => {
      if (!workspace?.id) {
        loadVersion.current += 1
        setProfile(null)
        setSessionId(null)
        setAttachments([])
        setFocusedProjectId(null)
        return
      }
      const version = ++loadVersion.current
      try {
        setError(null)
        // Never render the previous workspace's transcript/profile while the
        // next workspace is resolving. ChatPanel caches by session id, so this
        // reset is an access-boundary safeguard rather than cosmetic loading.
        setProfile(null)
        setSessionId(null)
        setAttachments([])
        setFocusedProjectId(null)
        const [session, nextProfile] = await Promise.all([
          api.getPrimaryWorkspaceSession(http, workspace.id),
          api.getAgentProfile(http, workspace.id),
        ])
        if (version !== loadVersion.current) return
        setProfile(nextProfile)
        setSessionId(session.id)
        publishPrimaryWorkspaceSession(workspace.id, session.id)
      } catch (cause) {
        if (version !== loadVersion.current) return
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load Workspace Agent Chat",
        )
      }
    }, [http, workspace?.id])

    useEffect(() => {
      void loadWorkspaceChat()
    }, [loadWorkspaceChat])

    useEffect(() => {
      if (!workspace?.id || !sessionId) {
        setAttachments([])
        return
      }
      let cancelled = false
      const loadAttachments = async () => {
        try {
          const next = await api.getWorkspaceSessionProjects(
            http,
            workspace.id,
            sessionId,
          )
          if (!cancelled) setAttachments(next)
        } catch {
          if (!cancelled) setAttachments([])
        }
      }
      void loadAttachments()
      void projects
        .loadAll({ workspaceId: workspace.id })
        .catch(() => undefined)
      const unsubscribe = subscribeWorkspaceSessionScopeChanged(
        workspace.id,
        (changedSessionId) => {
          if (changedSessionId === sessionId) void loadAttachments()
        },
      )
      return () => {
        cancelled = true
        unsubscribe()
      }
    }, [http, projects, sessionId, workspace?.id])

    useEffect(() => {
      if (
        focusedProjectId &&
        attachments.some(
          (attachment) => attachment.projectId === focusedProjectId,
        )
      )
        return
      setFocusedProjectId(attachments[0]?.projectId ?? null)
    }, [attachments, focusedProjectId])

    useEffect(() => {
      if (!crossTabPrefill) return
      setPrefillRequest(crossTabPrefill)
      clearChatPrefill(crossTabPrefill.nonce)
    }, [crossTabPrefill])

    const prefill = useCallback((content: string) => {
      setPrefillRequest({ nonce: Date.now(), content })
    }, [])
    const handlePrefillConsumed = useCallback((nonce: number) => {
      setPrefillRequest((current) =>
        current?.nonce === nonce ? null : current,
      )
    }, [])

    if (!workspace?.id || !sessionId || !profile) {
      return (
        <View className="flex-1 items-center justify-center bg-background px-6">
          {error ? (
            <>
              <Text className="text-center text-sm text-destructive">
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading Workspace Agent Chat"
                onPress={() => void loadWorkspaceChat()}
                className="mt-3 rounded-lg border border-border px-3 py-2 active:bg-muted"
              >
                <Text className="text-sm font-medium text-foreground">
                  Try again
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <ActivityIndicator />
              <Text className="mt-3 text-sm text-muted-foreground">
                Preparing Workspace Agent Chat…
              </Text>
            </>
          )}
        </View>
      )
    }

    const profileActions = buildDefaultProfileActions({
      agentName: profile.name,
      onPrefill: prefill,
      onOpenActivity: () => router.push("/(app)/activity" as any),
      onOpenSideChats: () => router.push("/(app)/side-chats" as any),
    })
    const projectName = (projectId: string) =>
      projects.all.find((project: any) => project.id === projectId)?.name ??
      `Project ${projectId.slice(0, 8)}`
    const attachableProjects = projects.all.filter(
      (project: any) =>
        project.workspaceId === workspace.id &&
        !attachments.some((attachment) => attachment.projectId === project.id),
    )

    const attachProject = async (projectId: string) => {
      const optimisticId = `pending-${projectId}`
      try {
        setScopeBusyProjectId(projectId)
        setScopeError(null)
        setAttachments((current) => [
          ...current,
          { id: optimisticId, projectId, attachMode: "readwrite" },
        ])
        const attached = await api.attachProject(
          http,
          workspace.id,
          sessionId,
          projectId,
          "readwrite",
        )
        setAttachments((current) => [
          ...current.filter((attachment) => attachment.id !== optimisticId),
          {
            id: attached.id,
            projectId: attached.projectId,
            attachMode: attached.attachMode as "readwrite" | "readonly",
          },
        ])
        setFocusedProjectId(projectId)
        publishWorkspaceSessionScopeChanged(workspace.id, sessionId)
      } catch {
        setAttachments((current) =>
          current.filter((attachment) => attachment.id !== optimisticId),
        )
        setScopeError(
          "Could not attach this project. Check access and try again.",
        )
      } finally {
        setScopeBusyProjectId(null)
      }
    }

    const detachProject = async (attachment: {
      id: string
      projectId: string
      attachMode: "readwrite" | "readonly"
    }) => {
      try {
        setScopeBusyProjectId(attachment.projectId)
        setScopeError(null)
        setAttachments((current) =>
          current.filter((item) => item.id !== attachment.id),
        )
        await api.detachWorkspaceSessionProject(
          http,
          workspace.id,
          sessionId,
          attachment.projectId,
        )
        publishWorkspaceSessionScopeChanged(workspace.id, sessionId)
      } catch {
        setAttachments((current) =>
          current.some((item) => item.id === attachment.id)
            ? current
            : [...current, attachment],
        )
        setScopeError(
          "Could not detach this project. It remains in the working set.",
        )
      } finally {
        setScopeBusyProjectId(null)
      }
    }

    const toggleProjectMode = async (attachment: {
      id: string
      projectId: string
      attachMode: "readwrite" | "readonly"
    }) => {
      const nextMode =
        attachment.attachMode === "readonly" ? "readwrite" : "readonly"
      try {
        setScopeBusyProjectId(attachment.projectId)
        setScopeError(null)
        setAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? { ...item, attachMode: nextMode }
              : item,
          ),
        )
        const updated = await api.attachProject(
          http,
          workspace.id,
          sessionId,
          attachment.projectId,
          nextMode,
        )
        setAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? {
                  ...item,
                  attachMode: updated.attachMode as "readwrite" | "readonly",
                }
              : item,
          ),
        )
        publishWorkspaceSessionScopeChanged(workspace.id, sessionId)
      } catch {
        setAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? { ...item, attachMode: attachment.attachMode }
              : item,
          ),
        )
        setScopeError(
          "Could not update project access. Your previous scope was restored.",
        )
      } finally {
        setScopeBusyProjectId(null)
      }
    }

    return (
      <View className="flex-1 bg-background">
        {usesMobileWorkspaceChrome ? (
          <PersonalAgentMobileHeader
            profile={profile}
            actions={profileActions}
          />
        ) : (
          <PersonalAgentHeader
            profile={profile}
            actions={profileActions}
            compact
          />
        )}
        {usesMobileWorkspaceChrome &&
        ((isPersonalWorkspace && showWelcome) ||
          gettingStarted.visible ||
          attachments.length > 0) ? (
          // `PersonalAgentMobileHeader` floats above this content instead of
          // reserving layout space, so the welcome card / working-set chip —
          // the first normal-flow content on this screen — need their own
          // clearance to avoid starting underneath the avatar/name
          // cluster (and the shell's floating menu/bell buttons).
          <View style={{ height: insets.top + 112 }} />
        ) : null}
        {isPersonalWorkspace && showWelcome ? (
          <View className="mx-auto mt-3 w-full max-w-2xl px-4">
            <View className="flex-row items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4">
              <Sparkles size={18} className="mt-0.5 text-primary" />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  Hi, I'm {profile.name}.
                </Text>
                <Text className="mt-1 text-sm leading-5 text-muted-foreground">
                  This is your Personal space: a private companion that
                  remembers your context and turns what you tell me into goals
                  and tasks. Try “Help me plan my week.”
                </Text>
                {teamWorkspaceId ? (
                  <Text className="mt-2 text-xs leading-4 text-muted-foreground">
                    Want to build agents and projects?{" "}
                    <Text
                      accessibilityRole="link"
                      onPress={() =>
                        openInWorkspace(
                          router,
                          teamWorkspaceId,
                          "/",
                          workspace.id,
                          projects,
                        )
                      }
                      className="font-medium text-primary"
                    >
                      Open your Team workspace
                    </Text>
                    .
                  </Text>
                ) : null}
              </View>
              <Pressable
                onPress={dismissWelcome}
                accessibilityLabel="Dismiss welcome message"
                className="h-7 w-7 items-center justify-center rounded-full active:bg-primary/10"
              >
                <X size={15} className="text-muted-foreground" />
              </Pressable>
            </View>
          </View>
        ) : null}
        {gettingStarted.visible ? (
          <View className="mx-auto mt-3 w-full max-w-2xl px-4">
            <GetStartedChecklist state={gettingStarted} />
          </View>
        ) : null}
        {attachments.length > 0 ? (
          <View className="mx-auto w-full max-w-[760px] flex-row items-center gap-2 px-4 pb-2 pt-3">
            <Text className="text-xs font-medium text-muted-foreground">
              Working set
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Manage project scope"
              onPress={() => setScopeSheetOpen(true)}
              className="max-w-[190px] rounded-full border border-border bg-card px-2.5 py-1 active:bg-muted"
            >
              <Text
                className="text-xs font-medium text-foreground"
                numberOfLines={1}
              >
                {projectName(focusedProjectId ?? attachments[0].projectId)}
              </Text>
            </Pressable>
            {attachments.length > 1 ? (
              <Text className="text-xs text-muted-foreground">
                +{attachments.length - 1}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View className="min-h-0 flex-1">
          <ChatPanel
            featureId={null}
            featureName={profile.name}
            phase={null}
            workspaceId={workspace.id}
            userId={user?.id}
            focusedProjectId={focusedProjectId}
            chatScope="workspace"
            chatSessionId={sessionId}
            onChatSessionChange={setSessionId}
            composer={experience.composer}
            presentation="agent"
            prefillRequest={prefillRequest}
            onPrefillConsumed={handlePrefillConsumed}
            className="flex-1"
            isActive
            phoneTranscriptTopPadding={
              usesMobileWorkspaceChrome ? "floating-agent" : "chrome"
            }
          />
        </View>
        <NativePhoneSheet
          visible={scopeSheetOpen}
          onClose={() => setScopeSheetOpen(false)}
          title="Project scope"
          subtitle="Choose what this chat can use"
          scroll
          draggable
          keyboardBehavior="scroll"
        >
          <View className="gap-2 px-4 pb-6 pt-2">
            {attachments.map((attachment) => {
              const focused = attachment.projectId === focusedProjectId
              const busy = scopeBusyProjectId === attachment.projectId
              return (
                <View
                  key={attachment.id}
                  className="rounded-xl border border-border bg-background p-3"
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Focus ${projectName(
                      attachment.projectId,
                    )} for the next prompt`}
                    onPress={() => setFocusedProjectId(attachment.projectId)}
                    className="flex-row items-center justify-between"
                  >
                    <Text
                      className="min-w-0 flex-1 text-sm font-semibold text-foreground"
                      numberOfLines={1}
                    >
                      {projectName(attachment.projectId)}
                    </Text>
                    {focused ? (
                      <Text className="ml-2 text-xs font-medium text-primary">
                        Focused
                      </Text>
                    ) : null}
                  </Pressable>
                  <View className="mt-3 flex-row gap-2">
                    <Pressable
                      disabled={busy}
                      onPress={() => void toggleProjectMode(attachment)}
                      className="rounded-lg border border-border px-2.5 py-1.5 disabled:opacity-50"
                    >
                      <Text className="text-xs text-foreground">
                        {attachment.attachMode === "readonly"
                          ? "Read only"
                          : "Can edit"}
                      </Text>
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => void detachProject(attachment)}
                      className="rounded-lg px-2.5 py-1.5 active:bg-destructive/10 disabled:opacity-50"
                    >
                      <Text className="text-xs text-destructive">Detach</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: "/(app)/projects/[id]",
                          params: {
                            id: attachment.projectId,
                            chatSessionId: sessionId,
                            chatScope: "workspace",
                          },
                        } as any)
                      }
                      className="rounded-lg px-2.5 py-1.5 active:bg-muted"
                    >
                      <Text className="text-xs text-primary">Open</Text>
                    </Pressable>
                  </View>
                </View>
              )
            })}
            <Text className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Add project
            </Text>
            {attachableProjects.length > 0 ? (
              attachableProjects.map((project: any) => (
                <Pressable
                  key={project.id}
                  disabled={scopeBusyProjectId !== null}
                  onPress={() => void attachProject(project.id)}
                  className="rounded-xl border border-border bg-background px-3 py-3 active:bg-muted disabled:opacity-50"
                >
                  <Text
                    className="text-sm font-medium text-foreground"
                    numberOfLines={1}
                  >
                    {project.name || "Untitled project"}
                  </Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">
                    Attach with read and write
                  </Text>
                </Pressable>
              ))
            ) : (
              <Text className="text-sm text-muted-foreground">
                Every accessible project is already attached.
              </Text>
            )}
            {scopeBusyProjectId ? (
              <Text
                accessibilityLiveRegion="polite"
                className="text-xs text-muted-foreground"
              >
                Preparing project context…
              </Text>
            ) : null}
            {scopeError ? (
              <Text
                accessibilityLiveRegion="polite"
                className="text-xs text-destructive"
              >
                {scopeError}
              </Text>
            ) : null}
          </View>
        </NativePhoneSheet>
      </View>
    )
  },
)
