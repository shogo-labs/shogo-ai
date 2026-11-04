// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The workspace-scoped Agent Chat surface shared by personal and team
 * workspaces. With no chat selected it opens the signed-in user's most
 * recent personal chat, creating one when they have none.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { ActivityIndicator, AppState, Platform, Pressable, Text, View, useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useRouter } from "expo-router"
import { observer } from "mobx-react-lite"
import { Sparkles, X } from "lucide-react-native"
import { useAuth } from "../../contexts/auth"
import { useActiveInstance } from "../../contexts/active-instance"
import {
  useDomainHttp,
  useMemberCollection,
  useProjectCollection,
  useWorkspaceCollection,
} from "../../contexts/domain"
import {
  openInWorkspace,
  adoptChatWorkspace,
  shouldAdoptChatWorkspace,
} from "../../lib/switch-workspace"
import { pickTeamWorkspace } from "../../lib/team-workspace"
import { useWorkspaceInView, type WorkspaceInView } from "../../hooks/useWorkspaceInView"
import { workspaceInViewWhileLoading } from "../../lib/workspace-in-view"
import {
  getActiveWorkspaceId,
  getCachedWorkspaceKind,
  subscribeActiveWorkspaceId,
} from "../../lib/workspace-store"
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience"
import { clearChatPrefill, useChatPrefill } from "../../hooks/useChatPrefill"
import { API_URL, api, type PersonalAgentProfile } from "../../lib/api"
import {
  bootWaitCanEndWithoutRecord,
  chatHistoryOrigin,
  loadWorkspaceChatBoot,
  peekWorkspaceChatBoot,
  rememberWorkspaceChatBoot,
  workspaceChatBootKey,
  workspaceChatLoadingView,
} from "../../lib/chat-device-boot"
import {
  chatActivityEvents,
  chatSessionEvents,
} from "../../lib/chat-session-events"
import {
  emptyWorkspaceChatActivity,
  nextWorkspaceChatActivity,
  workspaceChatActivityEvent,
  type WorkspaceChatActivityState,
} from "../../lib/workspace-chat-activity"
import { chatMentionMetaFor } from "../../lib/chat-mention-meta"
import { agentSessionSource } from "../../lib/root-destination"
import { ensureLandingSession, LANDING_SESSION_NAME } from "../../lib/landing-session"
import { ChatPanel } from "../chat/ChatPanel"
import type { OpenProjectPaneRequest } from "../chat/ChatContext"
import type { PlanData } from "../chat/PlanCard"
import { PlanStreamProvider } from "../chat/PlanStreamContext"
import { PlansPanel } from "../project/panels/PlansPanel"
import { ShareFileProvider, type ShareFileTarget } from "../chat/share-file-context"
import { ShareFileView } from "../chat/ShareFileViewer"
import { WorkspaceFileViewer } from "./WorkspaceFileViewer"
import { useFileLinkArrival } from "./use-file-link-arrival"
import { filePaneTarget } from "../chat/remote-project-paths"
import { projectAgentProxyBase } from "../../lib/agent-proxy-base"
import { ProjectSidePane } from "../team-chat/ProjectSidePane"
import { TaskThreadPaneHost } from "../chat/task/TaskThreadPaneHost"
import type { RestoreDraftRequest } from "../chat/ChatInput"
import { NativePhoneSheet } from "../phone/NativePhoneSheet"
import { PersonalAgentHeader } from "../personal/PersonalAgentHeader"
import { PersonalAgentMobileHeader } from "../personal/PersonalAgentMobileHeader"
import { BuddyLookSheet } from "../personal/BuddyLookSheet"
import { useWelcomeMessage } from "../personal/useWelcomeMessage"
import { buildDefaultProfileActions } from "../personal/ProfileActionMenu"
import type { BuddyState } from "../island/buddy/engine"
import { useMobileWorkspaceChrome } from "../layout/MobileWorkspaceChromeContext"
import {
  publishCurrentWorkspaceSession,
  publishWorkspaceSessionScopeChanged,
  subscribeWorkspaceSessionScopeChanged,
} from "./workspace-agent-session-bus"

/** Wide enough to show a project beside the chat (same as team chat's side pane). */
const PROJECT_SIDE_PANE_MIN_WIDTH = 1024

interface ProjectPaneState extends OpenProjectPaneRequest {
  /** Changes on every open so a new request re-targets the pane. */
  nonce: number
}

/**
 * The right-hand file pane. Both kinds of link land here — a workspace path the
 * assistant mentioned and a `share_file` link — so the pane Russell calls the
 * preview panel is the one place a file opens.
 */
type FilePaneState =
  | {
      kind: "path"
      /** Workspace-relative path the assistant mentioned. */
      path: string
      /**
       * The project that owns it, when the path names one (`<projectId>/…`).
       * Its files live in that project's own runtime, not in this one.
       */
      projectId: string | null
      /** Changes on every open so re-opening the same file reloads it. */
      nonce: number
    }
  | { kind: "share"; target: ShareFileTarget; nonce: number }

interface PlanPaneState {
  filepath: string | null
  /** Changes on every open so the Plans panel re-selects the requested plan. */
  nonce: number
}

interface BuildPlanRequest {
  plan: PlanData
  modelId: string
  nonce: number
}

export interface WorkspaceAgentChatScreenProps {
  /** Open this workspace session instead of the primary one (e.g. a session a DM reply ran in). */
  initialSessionId?: string
  /**
   * Start a new, empty session instead of resuming the primary one. The
   * landing (`/`) sets this; an explicit `?chatSessionId=` still wins.
   */
  startNewSession?: boolean
  /** Sent as the first message when the opened session is still empty. */
  initialMessage?: string
  /**
   * The file a shared link opened (`?file=`), already a workspace-relative
   * path. Opened in the file pane once, then dropped from the URL (SHO-284).
   */
  initialFilePath?: string | null
  /**
   * The workspace that link named (`?workspace=`). Adopted when this account is
   * a member of it; a non-member keeps the workspace they are in.
   */
  linkWorkspaceId?: string | null
  /** Rendered above the chat, e.g. the breadcrumb back to the conversation it was opened from. */
  header?: ReactNode
}

export const WorkspaceAgentChatScreen = observer(
  function WorkspaceAgentChatScreen({ initialSessionId, startNewSession, initialMessage, initialFilePath, linkWorkspaceId, header }: WorkspaceAgentChatScreenProps = {}) {
    const [capturedInitialMessage] = useState(() => initialMessage)
    const router = useRouter()
    const { user } = useAuth()
    const http = useDomainHttp()
    // The workspace in view: a paired computer's own workspace while it is
    // open, so its id and kind — not the cloud workspace that happens to be
    // selected — decide this chat's sessions, its scope and its chrome
    // (SHO-130).
    //
    // It has to survive the collection being between answers. `useActiveWorkspace()`
    // is null for the whole of every `loadAll()` — each in-app navigation
    // refetches it — and this screen remounts inside that window on every
    // reopen, so a plain `useWorkspaceInView()` loses the workspace for the
    // first frames of exactly the open this card is about: no id, no boot key,
    // no chat, and (before the loading view was fixed) a spinner over a
    // transcript the device already had (SHO-309).
    const inView = useWorkspaceInView()
    const selectedWorkspaceId = useSyncExternalStore(
      subscribeActiveWorkspaceId,
      getActiveWorkspaceId,
      getActiveWorkspaceId,
    )
    const lastInView = useRef<WorkspaceInView | null>(null)
    if (inView) lastInView.current = inView
    const cachedKind = useMemo(
      () => (inView ? null : getCachedWorkspaceKind(selectedWorkspaceId)),
      [inView, selectedWorkspaceId],
    )
    const workspace = workspaceInViewWhileLoading(
      inView,
      lastInView.current,
      selectedWorkspaceId,
      cachedKind,
    )
    const { instance: activeInstance } = useActiveInstance()
    // Which chat this workspace opens, and what its agent is called, are on the
    // device (SHO-309) — keyed the same way chat history is, so a paired
    // computer's workspace never reads a cloud one's answer.
    const bootKey = useMemo(
      () =>
        workspaceChatBootKey(
          user?.id,
          chatHistoryOrigin(activeInstance?.instanceId),
          workspace?.id,
        ),
      [user?.id, activeInstance?.instanceId, workspace?.id],
    )
    const projects = useProjectCollection()
    const experience = useWorkspaceExperience()
    const usesMobileWorkspaceChrome = useMobileWorkspaceChrome()
    const insets = useSafeAreaInsets()
    const { width, height } = useWindowDimensions()
    const [projectPane, setProjectPane] = useState<ProjectPaneState | null>(null)
    const [planPane, setPlanPane] = useState<PlanPaneState | null>(null)
    const [filePane, setFilePane] = useState<FilePaneState | null>(null)
    const [buildPlanRequest, setBuildPlanRequest] = useState<BuildPlanRequest | null>(null)
    // The first frame paints from what the device already holds: a chat that
    // has been opened before must not go through "Preparing Workspace Agent
    // Chat…" again (SHO-309).
    const [profile, setProfile] = useState<PersonalAgentProfile | null>(
      () => peekWorkspaceChatBoot<PersonalAgentProfile>(bootKey)?.profile ?? null,
    )
    const [sessionId, setSessionId] = useState<string | null>(() => {
      // An explicit chat, and the landing's empty chat, each name their own
      // session — only a plain open resumes the cached primary one.
      if (initialSessionId) return initialSessionId
      if (startNewSession) return null
      return peekWorkspaceChatBoot<PersonalAgentProfile>(bootKey)?.sessionId ?? null
    })
    // What the screen is showing right now, for a load that must not blank a
    // chat that is already painted.
    const shownIdentity = useRef<{
      sessionId: string | null
      profile: PersonalAgentProfile | null
    }>({ sessionId, profile })
    shownIdentity.current = { sessionId, profile }
    // The workspace whose identity is on screen. A re-run of the load for the
    // same workspace (a new `projects`/`http` identity) must not reset it.
    const shownWorkspace = useRef<string | null>(null)
    // True until the device read for this workspace has answered. While it is,
    // a chat we have opened before may be about to appear, so the screen shows
    // nothing rather than a loader (SHO-309).
    //
    // It starts true even before the key exists — `bootKey` needs the signed-in
    // user and the workspace in view, and this screen remounts on every reopen,
    // so on its first frame the key is still null. Starting false there is what
    // let the spinner paint on reopen: the key was not known yet, so nothing
    // looked pending, and "Preparing Workspace Agent Chat…" covered a chat the
    // device already had (SHO-309).
    const [bootPending, setBootPending] = useState(true)
    const [prefillRequest, setPrefillRequest] =
      useState<RestoreDraftRequest | null>(null)
    const [avatarState, setAvatarState] = useState<BuddyState>("idle")
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
    const [buddyLookSheetOpen, setBuddyLookSheetOpen] = useState(false)
    const [scopeBusyProjectId, setScopeBusyProjectId] = useState<string | null>(
      null,
    )
    const [scopeError, setScopeError] = useState<string | null>(null)
    const loadVersion = useRef(0)
    // The `?chatSessionId=` whose owning workspace this screen already adopted,
    // so a re-run of the load does not switch (or reload projects) twice.
    const adoptedChat = useRef<string | null>(null)
    // The workspace this screen mounted in. Adoption only applies while the
    // screen is still on it: a workspace change means the person left the chat
    // this screen was opened for (SHO-157).
    const screenWorkspace = useRef<string | null>(null)
    // The empty chat the landing opens. Single-flight per workspace so a
    // re-running load (a new `http` identity, a re-render) cannot mint a
    // second empty session; the session itself is reused across cold starts
    // (see `lib/landing-session`).
    const landingSession = useRef<{
      workspaceId: string
      promise: Promise<{ id: string }>
    } | null>(null)
    const reloadAttachments = useRef<(() => void) | null>(null)
    const avatarFinishedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const avatarStreaming = useRef(false)
    // What the sidebar paints: the spinner on this chat's row while its turn
    // runs, then the new-activity dot if the turn lands out of view.
    const [chatActivity, setChatActivity] = useState<WorkspaceChatActivityState>(
      emptyWorkspaceChatActivity,
    )
    const crossTabPrefill = useChatPrefill()
    const { showWelcome, dismissWelcome } = useWelcomeMessage(workspace?.id)
    const isPersonalWorkspace = experience.kind === "personal"
    const workspaces = useWorkspaceCollection()
    const members = useMemberCollection()
    const teamWorkspaceId = pickTeamWorkspace(
      (workspaces?.all ?? []) as Array<{ id: string; kind?: string }>,
      (members?.all ?? []) as any[],
      user?.id,
    )?.id

    // What the device read needs to know about the workspace collection, as
    // primitives. `workspaces.all` is a *fresh array on every access*
    // (`Array.from(self.items.values())`, see WorkspaceCollection), so using it
    // as a dependency restarts this effect on every render: each run cancels the
    // previous one before its read can answer, `bootPending` never clears, and
    // the first-ever open never paints its loader — it renders nothing and then
    // jumps straight to the chat when the profile and session land (SHO-309,
    // caught in CI).
    const workspaceCount = workspaces?.all?.length ?? 0
    const collectionReady =
      workspaces != null && workspaces.isLoading !== true

    // Read the chat this workspace opened last time off the device (SHO-309).
    // The first frame already used the synchronous mirror; this covers a
    // reload/restart, where the store has it and the mirror does not, and the
    // case where the key only became known after the first frame (a remount
    // whose user/workspace had not resolved yet) — there the state initialisers
    // ran against no key, so the record still has to be applied here.
    //
    // Keyed on the key alone: nothing the collection does changes what this
    // device holds for it, and re-running the read would only cancel itself.
    useEffect(() => {
      // Only fill what is still missing: a load that already answered is
      // fresher than the device copy, and the landing must keep its own empty
      // chat rather than opening the cached primary one.
      const applyBoot = (record: { sessionId: string | null; profile: PersonalAgentProfile | null } | null) => {
        if (!record) return
        const shown = shownIdentity.current
        if (record.profile && !shown.profile) setProfile(record.profile)
        if (
          record.sessionId &&
          !shown.sessionId &&
          !initialSessionId &&
          !startNewSession
        ) {
          setSessionId(record.sessionId)
        }
      }
      if (!bootKey) return
      const cached = peekWorkspaceChatBoot<PersonalAgentProfile>(bootKey)
      if (cached) {
        applyBoot(cached)
        setBootPending(false)
        return
      }
      let cancelled = false
      setBootPending(true)
      void loadWorkspaceChatBoot<PersonalAgentProfile>(bootKey)
        .then((record) => {
          if (cancelled) return
          applyBoot(record)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setBootPending(false)
        })
      return () => {
        cancelled = true
      }
    }, [bootKey, initialSessionId, startNewSession])

    // And the one case a missing key can never resolve: an account with no
    // workspaces at all. Only that may end the wait without a record.
    //
    // A null workspace is *not* that case: `useActiveWorkspace` returns null for
    // the whole of any `workspaces.loadAll()` (`isLoading`, which every in-app
    // navigation triggers) even though `all` still holds the list. Releasing the
    // wait there painted the spinner for the few frames the collection spent
    // refreshing — over a chat the device already had (SHO-309, caught in CI).
    //
    // Separate from the read above, and keyed on primitives, so a collection
    // refresh can neither cancel the read nor be missed by it.
    useEffect(() => {
      if (bootKey) return
      if (bootWaitCanEndWithoutRecord({ collectionReady, workspaceCount })) {
        setBootPending(false)
      }
    }, [bootKey, collectionReady, workspaceCount])

    const loadWorkspaceChat = useCallback(async () => {
      avatarStreaming.current = false
      setAvatarState("idle")
      setProjectPane(null)
      setPlanPane(null)
      setBuildPlanRequest(null)
      if (avatarFinishedTimer.current) {
        clearTimeout(avatarFinishedTimer.current)
        avatarFinishedTimer.current = null
      }
      if (!workspace?.id) {
        loadVersion.current += 1
        setProfile(null)
        setSessionId(null)
        setAttachments([])
        setFocusedProjectId(null)
        shownWorkspace.current = null
        return
      }
      const version = ++loadVersion.current
      if (screenWorkspace.current == null) screenWorkspace.current = workspace.id
      try {
        setError(null)
        // Never render the previous workspace's transcript/profile while the
        // next workspace is resolving. ChatPanel caches by session id, so this
        // reset is an access-boundary safeguard rather than cosmetic loading.
        //
        // It happens when the *workspace* changes, not when this load re-runs
        // for the same one: a new `projects`/`http` identity used to blank the
        // chat and remount it mid-session (SHO-309).
        if (shownWorkspace.current !== workspace.id) {
          shownWorkspace.current = workspace.id
          const boot = peekWorkspaceChatBoot<PersonalAgentProfile>(bootKey)
          setProfile(boot?.profile ?? null)
          setSessionId(
            initialSessionId ?? (startNewSession ? null : (boot?.sessionId ?? null)),
          )
          setAttachments([])
          setFocusedProjectId(null)
        }
        const sessionSource = agentSessionSource({
          initialSessionId,
          startNewSession,
          // The workspace the session belongs to, not the resolved
          // experience: they can disagree for a frame during a switch.
          kind: workspace.kind,
        })
        // `?chatSessionId=` comes from a chat chip, which can point at a chat
        // in another workspace. The session's workspace, not the URL, decides:
        // adopt it here — after boot, with the fact in hand — and return, so
        // this load re-runs against the right workspace instead of opening a
        // chat the server would refuse to take a send for.
        if (
          sessionSource === "url" &&
          initialSessionId &&
          shouldAdoptChatWorkspace({
            initialSessionId,
            adoptedSessionId: adoptedChat.current,
            screenWorkspaceId: screenWorkspace.current,
            workspaceId: workspace.id,
          })
        ) {
          const owner = await chatMentionMetaFor(initialSessionId)
          if (version !== loadVersion.current) return
          if (adoptChatWorkspace(owner?.workspaceId, workspace.id, projects)) {
            adoptedChat.current = initialSessionId
            return
          }
        }
        const openLandingSession = () => {
          const cached = landingSession.current
          if (cached && cached.workspaceId === workspace.id) {
            return cached.promise
          }
          const promise = ensureLandingSession(workspace.id, {
            list: (workspaceId) => api.listWorkspaceSessions(http, workspaceId),
            create: (workspaceId) =>
              api.createWorkspaceSession(http, workspaceId, {
                inferredName: LANDING_SESSION_NAME,
              }),
          })
          landingSession.current = { workspaceId: workspace.id, promise }
          promise.catch(() => {
            if (landingSession.current?.promise === promise) {
              landingSession.current = null
            }
          })
          return promise
        }
        const [session, nextProfile] = await Promise.all([
          sessionSource === "url"
            ? Promise.resolve({ id: initialSessionId as string })
            : sessionSource === "new"
              ? openLandingSession()
              : api.getPrimaryWorkspaceSession(http, workspace.id),
          api.getAgentProfile(http, workspace.id),
        ])
        if (version !== loadVersion.current) return
        setProfile(nextProfile)
        setSessionId(session.id)
        publishCurrentWorkspaceSession(workspace.id, session.id)
        // Answer for the next open, and for the island and side chats, which
        // read the same record (SHO-309). Only a plain open resumes the cached
        // session — a URL chat and the landing's empty chat are one-off
        // choices, not what "this workspace's chat" means.
        rememberWorkspaceChatBoot<PersonalAgentProfile>(bootKey, {
          profile: nextProfile,
          ...(sessionSource === "primary" ? { sessionId: session.id } : {}),
        })
      } catch (cause) {
        if (version !== loadVersion.current) return
        // A chat already on screen outranks a failed revalidation: keep it
        // rather than replacing it with an error (SHO-309).
        const shown = shownIdentity.current
        if (shown.sessionId && shown.profile) return
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load Workspace Agent Chat",
        )
      }
    }, [http, workspace?.id, workspace?.kind, initialSessionId, startNewSession, projects, bootKey])

    useEffect(() => {
      void loadWorkspaceChat()
    }, [loadWorkspaceChat])

    /**
     * The chat on screen belongs in the URL (SHO-287): reloading mid-turn, or
     * coming Back to this screen, must reopen the chat that is running rather
     * than mint an empty one.
     *
     * `replaceState`, not a router navigation: this is a label for the screen
     * already on display, and router params here would change the route key and
     * remount the panel — mid-turn, that is the bug, not the fix. A reload then
     * sees `?chatSessionId=` and the landing/agent route opens it.
     */
    useEffect(() => {
      if (Platform.OS !== "web" || !sessionId) return
      if (typeof window === "undefined" || !window.history?.replaceState) return
      const url = new URL(window.location.href)
      if (url.searchParams.get("chatSessionId") === sessionId) return
      url.searchParams.set("chatSessionId", sessionId)
      window.history.replaceState(window.history.state, "", url.toString())
    }, [sessionId])

    const hasSidePane = width >= PROJECT_SIDE_PANE_MIN_WIDTH && !usesMobileWorkspaceChrome
    // Plan, project, and file panes share one slot: opening any of them closes the others.
    const openProjectPane = useCallback((request: OpenProjectPaneRequest) => {
      setPlanPane(null)
      setFilePane(null)
      setProjectPane({ ...request, nonce: Date.now() })
    }, [])
    const closeProjectPane = useCallback(() => setProjectPane(null), [])
    const openPlanPane = useCallback((filepath?: string | null) => {
      setProjectPane(null)
      setFilePane(null)
      setPlanPane({ filepath: filepath ?? null, nonce: Date.now() })
    }, [])
    const closePlanPane = useCallback(() => setPlanPane(null), [])
    const openFilePane = useCallback((path: string) => {
      setProjectPane(null)
      setPlanPane(null)
      // `<projectId>/<path>` names a file in that project's own runtime; a bare
      // path is this workspace root's. Either way it opens in the same pane.
      const target = filePaneTarget(path)
      setFilePane({
        kind: "path",
        path: target.path,
        projectId: target.projectId,
        nonce: Date.now(),
      })
    }, [])
    const openShareFile = useCallback((target: ShareFileTarget) => {
      setProjectPane(null)
      setPlanPane(null)
      setFilePane({ kind: "share", target, nonce: Date.now() })
    }, [])

    // A shared file link (`/agent?workspace=&file=`, SHO-284) names the
    // workspace and the file. The workspace list decides whether this account
    // may be moved into that workspace; an empty list that is still loading is
    // "unknown", not "no".
    const memberWorkspaceIds =
      workspaces.all.length > 0 && !workspaces.isLoading
        ? (workspaces.all as Array<{ id: string }>).map((candidate) => candidate.id)
        : null
    const adoptLinkWorkspace = useCallback(
      (id: string) => {
        // A refused write is a switch the person made a moment ago, which
        // outranks this link; their choice stands and nothing opens.
        if (workspace?.id) adoptChatWorkspace(id, workspace.id, projects)
      },
      [projects, workspace?.id],
    )
    const { error: linkError, dismissError, dropLinkParams } = useFileLinkArrival({
      initialFilePath: initialFilePath ?? null,
      linkWorkspaceId: linkWorkspaceId ?? null,
      workspaceId: workspace?.id ?? null,
      memberWorkspaceIds,
      openFilePane,
      adoptWorkspace: adoptLinkWorkspace,
      setParams: (params) => router.setParams(params as any),
    })

    const closeFilePane = useCallback(() => {
      setFilePane(null)
      dropLinkParams()
    }, [dropLinkParams])
    const handleBuildPlan = useCallback(
      (plan: PlanData, modelId: string) => {
        setBuildPlanRequest({ plan, modelId, nonce: Date.now() })
        // The phone sheet covers the chat; get out of the way so the build is visible.
        if (!hasSidePane) setPlanPane(null)
      },
      [hasSidePane],
    )
    const handleBuildPlanConsumed = useCallback((nonce: number) => {
      setBuildPlanRequest((current) => (current?.nonce === nonce ? null : current))
    }, [])

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
      // The scope bus only reaches this tab; detaches from another tab or
      // device are picked up when the app returns to the foreground.
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") void loadAttachments()
      })
      reloadAttachments.current = () => void loadAttachments()
      return () => {
        cancelled = true
        unsubscribe()
        appState.remove()
        reloadAttachments.current = null
      }
    }, [http, projects, sessionId, workspace?.id])

    const handleChatError = useCallback((chatError: Error | null) => {
      if (chatError) reloadAttachments.current?.()
    }, [])

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
    const handleStreamingChange = useCallback(
      (isStreaming: boolean) => {
        if (avatarFinishedTimer.current)
          clearTimeout(avatarFinishedTimer.current)
        // Mirror the turn into the sidebar rows, the same way the project
        // workspace publishes its per-tab streaming state.
        if (sessionId) {
          setChatActivity((current) =>
            nextWorkspaceChatActivity(current, {
              sessionId,
              isStreaming,
              activeSessionId: sessionId,
            }),
          )
        }
        if (isStreaming) {
          avatarStreaming.current = true
          setAvatarState("working")
          return
        }
        if (!avatarStreaming.current) {
          setAvatarState("idle")
          return
        }
        if (workspace?.id && sessionId) {
          chatSessionEvents.emit({
            workspaceId: workspace.id,
            activeSessionId: sessionId,
            refresh: true,
          })
        }
        avatarStreaming.current = false
        setAvatarState("finished")
        avatarFinishedTimer.current = setTimeout(() => {
          avatarFinishedTimer.current = null
          setAvatarState("idle")
        }, 1800)
      },
      [sessionId, workspace?.id],
    )
    useEffect(
      () => () => {
        if (avatarFinishedTimer.current)
          clearTimeout(avatarFinishedTimer.current)
      },
      [],
    )

    // Publish this chat's activity so the Home panel and the phone drawer can
    // paint the spinner + new-activity dot. Kept off `chatSessionEvents` so a
    // stream tick never triggers a chat-list re-fetch.
    useEffect(() => {
      if (!workspace?.id) return
      chatActivityEvents.emit(
        workspaceChatActivityEvent(workspace.id, chatActivity),
      )
    }, [chatActivity, workspace?.id])

    // A turn belongs to the chat that is on screen: switching chats (or leaving
    // the screen) drops the old state so a stale row cannot spin forever.
    useEffect(() => {
      setChatActivity(emptyWorkspaceChatActivity)
    }, [sessionId])

    useEffect(() => {
      if (!workspace?.id) return
      const workspaceId = workspace.id
      return () => {
        chatActivityEvents.emit({
          workspaceId,
          streamingSessionIds: [],
          completedSessionIds: [],
        })
      }
    }, [workspace?.id])

    // Another project's runtime, for a file this chat's agent wrote there.
    // Above the early return: a hook below it changes the hook order between
    // the loading render and the loaded one (SHO-247).
    const projectAgentUrl = useCallback(
      (projectId: string) =>
        projectAgentProxyBase({
          projectId,
          apiUrl: API_URL,
        }),
      [],
    )

    const loadingView = workspaceChatLoadingView({
      hasWorkspace: !!workspace?.id,
      hasProfile: !!profile,
      hasSession: !!sessionId,
      bootPending,
      error,
    })

    if (!workspace?.id || !sessionId || !profile) {
      return (
        <View className="flex-1 items-center justify-center bg-background px-6">
          {loadingView === "error" ? (
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
          ) : loadingView === "spinner" ? (
            <>
              <ActivityIndicator />
              <Text className="mt-3 text-sm text-muted-foreground">
                Preparing Workspace Agent Chat…
              </Text>
            </>
          ) : (
            // The device read has not answered yet: a chat opened before is
            // about to appear, so this frame shows nothing rather than a
            // loader that would flash and go (SHO-309).
            null
          )}
        </View>
      )
    }

    const profileActions = buildDefaultProfileActions({
      agentName: profile.name,
      onPrefill: prefill,
      onCustomizeAvatar: () => setBuddyLookSheetOpen(true),
      onOpenActivity: () => router.push("/(app)/activity" as any),
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

    const activePane = hasSidePane ? projectPane : null
    const workspaceAgentUrl = `${API_URL}/api/workspaces/${workspace.id}/agent-proxy`
    const plansPanel = planPane ? (
      <PlansPanel
        visible
        agentUrl={workspaceAgentUrl}
        requestedPlanPath={planPane}
        onBuildPlan={handleBuildPlan}
        onClose={closePlanPane}
      />
    ) : null
    const filePaneContent = filePane ? (
      filePane.kind === "share" ? (
        <ShareFileView
          key={`${filePane.target.href}:${filePane.nonce}`}
          target={filePane.target}
          embedded
          onClose={closeFilePane}
        />
      ) : (
        <WorkspaceFileViewer
          agentUrl={workspaceAgentUrl}
          path={filePane.path}
          projectId={filePane.projectId}
          projectName={
            filePane.projectId ? projectName(filePane.projectId) : null
          }
          workspaceId={workspace.id}
          nonce={filePane.nonce}
          onClose={closeFilePane}
        />
      )
    ) : null

    return (
      <PlanStreamProvider>
      <ShareFileProvider open={openShareFile}>
      <View className="flex-1 flex-row bg-background">
      <View className="min-w-0 flex-1 bg-background">
        {usesMobileWorkspaceChrome ? (
          <PersonalAgentMobileHeader
            profile={profile}
            actions={profileActions}
            avatarState={avatarState}
          />
        ) : (
          <PersonalAgentHeader
            profile={profile}
            actions={profileActions}
            avatarState={avatarState}
            compact
          />
        )}
        {header ? (
          // Opened from a team chat message: the trail back. On phones the
          // floating header needs the same clearance the content below gets.
          <View style={usesMobileWorkspaceChrome ? { paddingTop: insets.top + 112 } : undefined}>
            {header}
          </View>
        ) : null}
        {usesMobileWorkspaceChrome &&
        !header &&
        ((isPersonalWorkspace && showWelcome) || attachments.length > 0) ? (
          // `PersonalAgentMobileHeader` floats above this content instead of
          // reserving layout space, so the welcome card / working-set chip —
          // the first normal-flow content on this screen — need their own
          // clearance to avoid starting underneath the avatar/name
          // cluster (and the shell's floating menu/bell buttons).
          <View style={{ height: insets.top + 112 }} />
        ) : null}
        {linkError ? (
          <View
            className="mx-auto mt-3 w-full max-w-2xl flex-row items-start gap-2 px-4"
            testID="workspace-file-link-denied"
          >
            <Text className="min-w-0 flex-1 text-sm text-destructive">{linkError}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => dismissError()}
              className="h-7 w-7 items-center justify-center rounded-full active:bg-muted"
            >
              <X size={15} className="text-muted-foreground" />
            </Pressable>
          </View>
        ) : null}
        {isPersonalWorkspace && showWelcome ? (
          <View className="mx-auto mt-3 w-full max-w-2xl px-4">
            <View className="flex-row items-start gap-3 rounded-2xl border border-primary/30 bg-transparent p-4">
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
            onChatError={handleChatError}
            onStreamingChange={handleStreamingChange}
            composer={experience.composer}
            presentation="agent"
            onOpenProjectPane={hasSidePane ? openProjectPane : undefined}
            onOpenPlan={isPersonalWorkspace ? undefined : openPlanPane}
            onOpenFilePath={openFilePane}
            projectAgentUrl={projectAgentUrl}
            buildPlanRequest={buildPlanRequest}
            onBuildPlanConsumed={handleBuildPlanConsumed}
            prefillRequest={prefillRequest}
            onPrefillConsumed={handlePrefillConsumed}
            initialMessage={capturedInitialMessage}
            className="flex-1"
            isActive
            ownsPlanStream
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
        <BuddyLookSheet visible={buddyLookSheetOpen} onClose={() => setBuddyLookSheetOpen(false)} />
        {!hasSidePane ? (
          <NativePhoneSheet
            visible={!!planPane}
            onClose={closePlanPane}
            grabber={false}
            testID="workspace-plan-sheet"
          >
            <View style={{ height: Math.round(height * 0.8) }}>{plansPanel}</View>
          </NativePhoneSheet>
        ) : null}
        {!hasSidePane && filePane?.kind === "path" ? (
          <NativePhoneSheet
            visible
            onClose={closeFilePane}
            grabber={false}
            testID="workspace-file-sheet"
          >
            <View style={{ height: Math.round(height * 0.8) }}>{filePaneContent}</View>
          </NativePhoneSheet>
        ) : null}
        {!hasSidePane && filePane?.kind === "share" ? (
          <NativePhoneSheet
            visible
            onClose={closeFilePane}
            grabber={false}
            testID="workspace-share-file-sheet"
          >
            <View style={{ height: Math.round(height * 0.8) }}>{filePaneContent}</View>
          </NativePhoneSheet>
        ) : null}
      </View>
      {hasSidePane && plansPanel ? (
        <View className="w-[45%] min-w-[420px] border-l border-border" testID="workspace-plan-pane">
          {plansPanel}
        </View>
      ) : null}
      {hasSidePane && filePane ? (
        <View
          className="w-[45%] min-w-[420px] border-l border-border"
          testID={filePane.kind === "share" ? "workspace-share-file-pane" : "workspace-file-pane"}
        >
          {filePaneContent}
        </View>
      ) : null}
      {activePane ? (
        <View className="w-[45%] min-w-[420px] border-l border-border" testID="workspace-project-pane">
          <ProjectSidePane
            key={`${activePane.projectId}:${activePane.chatSessionId ?? ""}:${activePane.nonce}`}
            projectId={activePane.projectId}
            workspaceId={workspace.id}
            name={activePane.name ?? projectName(activePane.projectId)}
            initialTab={activePane.tab ?? (activePane.chatSessionId ? "chat" : "canvas")}
            chatSessionId={activePane.chatSessionId}
            onClose={closeProjectPane}
          />
        </View>
      ) : null}
      {/* The thread a pressed background task runs in — beside the chat on
          desktop, in a sheet on phones. Never replaces this chat. */}
      <TaskThreadPaneHost />
      </View>
      </ShareFileProvider>
      </PlanStreamProvider>
    )
  },
)
