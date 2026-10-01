// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Pressable, ScrollView, Text, View, useWindowDimensions, type LayoutChangeEvent } from "react-native"
import { Motion } from "@legendapp/motion"
import { observer } from "mobx-react-lite"
import { ChevronDown, ChevronLeft, ChevronsUpDown, ExternalLink, Minus } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { useDomainActions } from "../../contexts/domain"
import { API_URL } from "../../lib/api"
import { loadModelPreference } from "../../lib/agent-mode-preference"
import type { ChatSendInteractionMode } from "../../lib/chat-send-body"
import { DEFAULT_MODEL_FREE, DEFAULT_MODEL_PRO } from "../chat/ChatInput"
import { buddyStateForSnapshot } from "./buddy/buddy-state"
import { IslandBuddy, type IslandBuddyEntrance } from "./buddy/IslandBuddy"
import { normalizeBuddyLook } from "./buddy/look"
import { IslandChatHost, type IslandInitialSend } from "./IslandChatHost"
import { useIslandAccent } from "./island-accent"
import { IslandCollapsed, type IslandPeek } from "./IslandCollapsed"
import { IslandIdle } from "./IslandIdle"
import { IslandComposer, fileRefsFromFileList, type IslandComposerHandle } from "./IslandComposer"
import { IslandConversation } from "./IslandConversation"
import { IslandDropSheet } from "./IslandDropSheet"
import { IslandMeetingBanner } from "./IslandMeeting"
import { useIslandMeetingNotes } from "./useIslandMeetingNotes"
import { IslandPlanReview } from "./IslandPlanReview"
import { IslandUsageChip, IslandUsagePanel, useIslandUsage } from "./IslandUsageChip"
import { PermissionCard, QuestionCard } from "./PendingCard"
import { ProjectSwitcher, useWorkspaceProjects } from "./ProjectSwitcher"
import { SessionList, SessionRow } from "./SessionList"
import { planAddToProject, saveAttachmentsPrompt, type IslandDropAction } from "./island-drop"
import { inboxSessions, orderIslandSessions, sortIslandProjects, type IslandProjectItem } from "./island-inbox"
import {
  IDLE_TAB_HEIGHT,
  IDLE_TAB_WIDTH,
  IDLE_NOTCHED_WIDTH,
  ISLAND_CLOSE,
  ISLAND_CLOSE_MS,
  ISLAND_CONTENT_IN,
  ISLAND_CONTENT_OUT,
  ISLAND_HOVER,
  ISLAND_OPEN,
  NOTCH_WIDTH,
  islandMotion,
} from "./island-motion"
import { islandSoundForTransition, meetingSoundForTransition, playIslandSound } from "./island-sounds"
import type { IslandChatSession } from "./useIslandChatSession"
import { useIslandBridge } from "./useIslandBridge"
import { useIslandPointer } from "./useIslandPointer"
import {
  ISLAND_SURFACE_PROPS,
  islandSessionKey,
  type IslandBridge,
  type IslandFileRef,
  type IslandMeetingDecision,
  type IslandMeetingState,
  type IslandResult,
  type IslandMode,
  type IslandSnapshot,
} from "./types"

const PEEK_MS = 4000
const MAX_CARD_HEIGHT = 640
/** The island always sends in agent mode; plan mode lives in the full app. */
const ISLAND_INTERACTION_MODE: ChatSendInteractionMode = "agent"
const PICKER_WIDTH = 300
const PICKER_HEIGHT = 320

type IslandView =
  | { name: "inbox" }
  | {
      name: "project"
      projectId: string
      projectName: string
      initialFiles?: IslandFileRef[]
    }
  | {
      name: "chat"
      projectId: string
      projectName: string
      sessionId: string
      title: string
      initialSend?: IslandInitialSend
      initialFiles?: IslandFileRef[]
    }
  | { name: "drop"; files: IslandFileRef[]; returnTo: IslandView }

function parentView(view: IslandView): IslandView | null {
  switch (view.name) {
    case "inbox":
      return null
    case "drop":
      return view.returnTo
    case "project":
      return { name: "inbox" }
    case "chat":
      return {
        name: "project",
        projectId: view.projectId,
        projectName: view.projectName,
      }
  }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(media.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    media.addEventListener?.("change", onChange)
    return () => media.removeEventListener?.("change", onChange)
  }, [])
  return reduced
}

function useModelId(projectId: string | null, hasAdvancedModelAccess: boolean): string {
  const fallback = hasAdvancedModelAccess ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE
  const [stored, setStored] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadModelPreference(projectId ?? undefined).then((value) => !cancelled && setStored(value))
    return () => {
      cancelled = true
    }
  }, [projectId])
  return stored ?? fallback
}

async function writeProjectFile(projectId: string, path: string, content: string): Promise<void> {
  const base = `${API_URL}/api/projects/${encodeURIComponent(projectId)}/files/`
  const dot = path.lastIndexOf(".")
  const stem = dot > 0 ? path.slice(0, dot) : path
  const ext = dot > 0 ? path.slice(dot) : ""
  // Never overwrite: pick the first free "name-n.ext".
  let target = path
  for (let attempt = 1; attempt <= 20; attempt++) {
    const probe = await fetch(base + encodeURIComponent(target), {
      credentials: "include",
    })
    if (probe.status === 404) break
    target = `${stem}-${attempt}${ext}`
  }
  const res = await fetch(base + encodeURIComponent(target), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error(`Couldn't save ${path} (HTTP ${res.status})`)
}

function peekFor(previous: IslandSnapshot, next: IslandSnapshot): IslandPeek | null {
  const before = new Map(previous.sessions.map((s) => [islandSessionKey(s.projectId, s.sessionId), s]))
  for (const session of next.sessions) {
    const prior = before.get(islandSessionKey(session.projectId, session.sessionId))
    if (prior?.status === "running" && session.status === "done") {
      const firstLine = (session.replyPreview ?? "").split("\n").find((line) => line.trim()) ?? "Done"
      return { title: session.projectName, detail: firstLine.trim() }
    }
  }
  return null
}

export const IslandApp = observer(function IslandApp({
  workspaceId,
  userId,
}: {
  workspaceId: string | undefined
  userId: string | undefined
}) {
  const { bridge, snapshot, layout, meeting, requestMode: applyMode } = useIslandBridge()
  const actions = useDomainActions()
  const reducedMotion = usePrefersReducedMotion()
  const [view, setView] = useState<IslandView>({ name: "inbox" })
  const [usageOpen, setUsageOpen] = useState(false)
  const [peek, setPeek] = useState<IslandPeek | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerOpenRef = useRef(false)
  pickerOpenRef.current = pickerOpen
  const { width: windowWidth } = useWindowDimensions()
  const composerRef = useRef<IslandComposerHandle>(null)
  const hasDraftRef = useRef(false)
  const viewRef = useRef(view)
  viewRef.current = view
  const pendingRef = useRef(false)
  const meetingPromptRef = useRef(false)
  meetingPromptRef.current = !!meeting.prompt

  const cardOpen = layout.mode === "expanded" || layout.mode === "compose"

  // Each mode mounts its own buddy; the mode it replaced picks the entrance.
  const lastMode = useRef(layout.mode)
  const arrivedFrom = lastMode.current
  useEffect(() => {
    lastMode.current = layout.mode
  }, [layout.mode])
  const buddyLook = useMemo(() => normalizeBuddyLook(snapshot.buddyLook), [snapshot.buddyLook])
  const buddyState = peek ? "finished" : buddyStateForSnapshot(snapshot)
  const accent = useIslandAccent()
  const openEntrance: IslandBuddyEntrance =
    arrivedFrom !== "hidden" ? "character" : layout.notched ? "unfold" : "appear"

  // Closing the card plays its fold back into the notch while the window is
  // still card-sized, then asks main to shrink it. Opening needs no delay:
  // main grows the window first and the card animates out of the notch.
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cardOpenRef = useRef(cardOpen)
  cardOpenRef.current = cardOpen
  const requestMode = useCallback(
    (mode: IslandMode) => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
      closeTimer.current = null
      const closingCard = cardOpenRef.current && (mode === "collapsed" || mode === "hidden")
      if (!closingCard || reducedMotion) {
        setClosing(false)
        applyMode(mode)
        return
      }
      setClosing(true)
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null
        applyMode(mode)
      }, ISLAND_CLOSE_MS)
    },
    [applyMode, reducedMotion],
  )
  useEffect(() => {
    if (!cardOpen) {
      setClosing(false)
      setPickerOpen(false)
    }
  }, [cardOpen])
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    [],
  )
  const usage = useIslandUsage(workspaceId, cardOpen)
  const projects = useWorkspaceProjects(workspaceId)
  const sortedProjects = useMemo(() => sortIslandProjects(projects, snapshot.sessions), [projects, snapshot.sessions])
  const orderedSessions = useMemo(
    () => orderIslandSessions(inboxSessions(snapshot.sessions, snapshot.focusedSessionKey)),
    [snapshot.focusedSessionKey, snapshot.sessions],
  )

  const currentProjectId =
    view.name === "chat" || view.name === "project"
      ? view.projectId
      : (orderedSessions[0]?.projectId ?? sortedProjects[0]?.id ?? null)
  const currentProjectName =
    view.name === "chat" || view.name === "project"
      ? view.projectName
      : (orderedSessions[0]?.projectName ?? sortedProjects.find((p) => p.id === currentProjectId)?.name ?? "Project")
  const modelId = useModelId(currentProjectId, usage.hasAdvancedModelAccess)

  const canAutoCollapse = useCallback(
    () =>
      !hasDraftRef.current &&
      !pendingRef.current &&
      !meetingPromptRef.current &&
      !pickerOpenRef.current &&
      (viewRef.current.name === "inbox" || viewRef.current.name === "project" || viewRef.current.name === "chat"),
    [],
  )
  useIslandPointer({ bridge, mode: layout.mode, requestMode, canAutoCollapse })

  const focusForTyping = useCallback(() => {
    if (layout.mode !== "compose") requestMode("compose")
  }, [layout.mode, requestMode])

  const collapse = useCallback(() => {
    setUsageOpen(false)
    requestMode("collapsed")
  }, [requestMode])

  const goBack = useCallback(() => {
    const parent = parentView(viewRef.current)
    if (parent) setView(parent)
    else collapse()
  }, [collapse])

  // ── Snapshot side effects: sounds, completion peek, jump to new requests ──
  const previousSnapshot = useRef<IslandSnapshot>(snapshot)
  useEffect(() => {
    const previous = previousSnapshot.current
    previousSnapshot.current = snapshot
    if (previous === snapshot) return
    const sound = islandSoundForTransition(previous, snapshot)
    if (sound && layout.sounds) playIslandSound(sound, layout.soundVolume)

    const nextPeek = peekFor(previous, snapshot)
    if (nextPeek && !cardOpen) setPeek(nextPeek)

    const seen = new Set(previous.sessions.flatMap((s) => (s.pending ? [s.pending.request.id] : [])))
    const fresh = snapshot.sessions.find((s) => s.pending && !seen.has(s.pending.request.id))
    const current = viewRef.current
    if (fresh && !hasDraftRef.current && current.name !== "drop" && !pickerOpenRef.current) {
      setView({
        name: "chat",
        projectId: fresh.projectId,
        projectName: fresh.projectName,
        sessionId: fresh.sessionId,
        title: fresh.title,
      })
    }
  }, [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps

  const previousMeeting = useRef<IslandMeetingState>(meeting)
  useEffect(() => {
    const previous = previousMeeting.current
    previousMeeting.current = meeting
    if (previous === meeting) return
    const sound = meetingSoundForTransition(previous, meeting)
    if (sound && layout.sounds) playIslandSound(sound, layout.soundVolume)
    // A prompt that opened the island shouldn't leave it open once it's gone.
    if (previous.prompt && !meeting.prompt && layout.mode === "expanded" && canAutoCollapse()) {
      requestMode("collapsed")
    }
  }, [meeting]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!peek) return
    const timer = setTimeout(() => setPeek(null), PEEK_MS)
    return () => clearTimeout(timer)
  }, [peek])

  // ── Window-level input: keys, drops, focus, compose shortcut ──
  useEffect(() => {
    if (!bridge) return
    return bridge.onOpenCompose(() => {
      setTimeout(() => composerRef.current?.focus(), 30)
    })
  }, [bridge])

  useEffect(() => {
    if (typeof window === "undefined") return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (pickerOpenRef.current) setPickerOpen(false)
        else if (usageOpen) setUsageOpen(false)
        else goBack()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPickerOpen((open) => !open)
      }
    }
    const onBlur = () => {
      if (layout.mode !== "compose") return
      requestMode(canAutoCollapse() ? "collapsed" : "expanded")
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("blur", onBlur)
    }
  }, [canAutoCollapse, goBack, layout.mode, requestMode, usageOpen])

  useEffect(() => {
    if (!bridge || typeof document === "undefined") return
    const onDragOver = (event: DragEvent) => event.preventDefault()
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      const items = Array.from(event.dataTransfer?.items ?? [])
      if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        setNotice("Folders can't be dropped here. Drop the files inside instead.")
        if (layout.mode === "hidden" || layout.mode === "collapsed") requestMode("expanded")
        return
      }
      const files = fileRefsFromFileList(bridge, event.dataTransfer?.files ?? null)
      if (!files.length) return
      setNotice(null)
      setView((current) => ({
        name: "drop",
        files,
        returnTo: current.name === "drop" ? current.returnTo : current,
      }))
      if (layout.mode === "hidden" || layout.mode === "collapsed") requestMode("expanded")
    }
    document.addEventListener("dragover", onDragOver)
    document.addEventListener("drop", onDrop)
    return () => {
      document.removeEventListener("dragover", onDragOver)
      document.removeEventListener("drop", onDrop)
    }
  }, [bridge, layout.mode, requestMode])

  // ── Actions ──
  const openInShogo = useCallback(
    (projectId: string, sessionId?: string) => {
      if (!bridge) return
      void (sessionId
        ? bridge.sendAction({ type: "open", projectId, sessionId })
        : bridge.sendAction({
            type: "navigate",
            path: `/projects/${encodeURIComponent(projectId)}`,
          }))
      collapse()
    },
    [bridge, collapse],
  )

  const respondToMeeting = useCallback(
    (decision: IslandMeetingDecision, promptId?: string) => {
      if (!bridge) return
      void bridge
        .sendAction({
          type: "meeting",
          decision,
          ...(promptId ? { promptId } : {}),
        })
        .then((result) => {
          if (!result.ok) setNotice(result.error)
        })
    },
    [bridge],
  )

  const openMeetings = useCallback(() => {
    void bridge?.sendAction({ type: "navigate", path: "/meetings" })
    collapse()
  }, [bridge, collapse])

  const meetingNotes = useIslandMeetingNotes(meeting.recording)
  const openMeeting = useCallback(
    (meetingId: string) => {
      void bridge?.sendAction({
        type: "navigate",
        path: `/meetings/${meetingId}`,
      })
      collapse()
    },
    [bridge, collapse],
  )

  const openBilling = useCallback(() => {
    void bridge?.sendAction({ type: "navigate", path: "/billing" })
    collapse()
  }, [bridge, collapse])

  const openChat = useCallback(
    (
      projectId: string,
      projectName: string,
      sessionId: string,
      title: string,
      extra?: {
        initialSend?: IslandInitialSend
        initialFiles?: IslandFileRef[]
      },
    ) =>
      setView({
        name: "chat",
        projectId,
        projectName,
        sessionId,
        title,
        ...extra,
      }),
    [],
  )

  const startNewChat = useCallback(
    async (projectId: string, projectName: string, initialSend: IslandInitialSend): Promise<IslandResult> => {
      try {
        const session = await actions.createChatSession({
          inferredName: "Untitled",
          contextType: "project",
          contextId: projectId,
        })
        if (!session?.id) return { ok: false, error: "Couldn't start a chat" }
        openChat(projectId, projectName, session.id, "New chat", {
          initialSend,
        })
        if (layout.sounds) playIslandSound("sent", layout.soundVolume)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
    [actions, layout.soundVolume, layout.sounds, openChat],
  )

  const handleDrop = useCallback(
    async (action: IslandDropAction, projectId: string, files: IslandFileRef[], returnTo: IslandView) => {
      if (!bridge) return { ok: false, error: "Island unavailable" } as IslandResult
      const projectName = projects.find((p) => p.id === projectId)?.name ?? "Project"
      if (action === "attach") {
        if (returnTo.name === "chat" || returnTo.name === "project") setView({ ...returnTo, initialFiles: files })
        return { ok: true } as IslandResult
      }
      if (action === "new-chat") {
        setView({
          name: "project",
          projectId,
          projectName,
          initialFiles: files,
        })
        return { ok: true } as IslandResult
      }
      const read = await bridge.readFiles(files)
      if (!read.ok) return read
      const plan = planAddToProject(read.attachments)
      try {
        for (const write of plan.writes) await writeProjectFile(projectId, write.path, write.content)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as IslandResult
      }
      if (plan.attach.length > 0) {
        return startNewChat(projectId, projectName, {
          text: saveAttachmentsPrompt(plan.attach),
          attachments: plan.attach,
        })
      }
      return { ok: true } as IslandResult
    },
    [bridge, projects, startNewChat],
  )

  // ── Layout: report the card height so the window never outgrows it ──
  const maxCardHeight = useMemo(() => {
    const avail = typeof window !== "undefined" ? window.screen?.availHeight : undefined
    return Math.min(MAX_CARD_HEIGHT, avail ? Math.floor(avail * 0.85) : MAX_CARD_HEIGHT)
  }, [])
  const onCardLayout = useCallback(
    (event: LayoutChangeEvent) => bridge?.setContentHeight(event.nativeEvent.layout.height),
    [bridge],
  )

  if (!bridge) return null

  if (layout.mode === "hidden") {
    return (
      <View className="dark" style={{ width: "100%", height: "100%" }}>
        <IslandIdle
          layout={layout}
          reducedMotion={reducedMotion}
          look={buddyLook}
          buddyState={buddyState}
          entrance={arrivedFrom === "hidden" ? "logo" : "fold"}
          onExpand={() => requestMode("expanded")}
        />
      </View>
    )
  }

  if (layout.mode === "collapsed") {
    return (
      <View className="dark" style={{ width: "100%", height: "100%" }}>
        <IslandCollapsed
          snapshot={snapshot}
          meeting={meeting}
          layout={layout}
          peek={peek}
          reducedMotion={reducedMotion}
          look={buddyLook}
          buddyState={buddyState}
          entrance={openEntrance}
          onExpand={() => requestMode("expanded")}
        />
      </View>
    )
  }

  const headerTitle =
    view.name === "chat"
      ? view.title
      : view.name === "project"
        ? view.projectName
        : view.name === "drop"
          ? "Dropped files"
          : "Shogo"
  const headerSubtitle = view.name === "chat" ? view.projectName : undefined

  const header = (
    <View className="flex-row items-center gap-1.5 px-3" style={{ height: layout.notched ? layout.topInset : 40 }}>
      <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
        <IslandBuddy
          body={16}
          width={22}
          height={layout.notched ? layout.topInset : 40}
          state={buddyState}
          color={accent}
          look={buddyLook}
          entrance={openEntrance}
          followPointer
          reducedMotion={reducedMotion}
        />
        {view.name !== "inbox" ? (
          <Pressable onPress={goBack} accessibilityLabel="Back" hitSlop={6}>
            <ChevronLeft size={15} color="#d4d4d8" />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => setPickerOpen((open) => !open)}
          className={cn(
            "min-w-0 flex-row items-center gap-1 rounded-md px-1 py-0.5 -mx-1",
            pickerOpen ? "bg-white/10" : "hover:bg-white/5",
          )}
          accessibilityLabel="Switch project"
          aria-expanded={pickerOpen}
        >
          <View className="min-w-0">
            <Text className="text-[12px] font-semibold text-zinc-50" numberOfLines={1}>
              {headerTitle}
            </Text>
            {headerSubtitle && !layout.notched ? (
              <Text className="text-[10px] text-zinc-500" numberOfLines={1}>
                {headerSubtitle}
              </Text>
            ) : null}
          </View>
          <Motion.View
            animate={{ rotate: pickerOpen ? "180deg" : "0deg" }}
            transition={islandMotion(reducedMotion, ISLAND_CONTENT_OUT)}
          >
            <ChevronDown size={12} color={pickerOpen ? "#e4e4e7" : "#71717a"} />
          </Motion.View>
        </Pressable>
      </View>
      {layout.notched ? <View style={{ width: NOTCH_WIDTH }} /> : null}
      <View className="flex-1 flex-row items-center justify-end gap-2">
        <IslandUsageChip usage={usage} onPress={() => setUsageOpen((open) => !open)} />
        {view.name === "chat" || view.name === "project" ? (
          <Pressable
            onPress={() => openInShogo(view.projectId, view.name === "chat" ? view.sessionId : undefined)}
            accessibilityLabel="Open in Shogo"
            hitSlop={6}
          >
            <ExternalLink size={13} color="#a1a1aa" />
          </Pressable>
        ) : null}
        <Pressable onPress={collapse} accessibilityLabel="Collapse" hitSlop={6}>
          <Minus size={14} color="#a1a1aa" />
        </Pressable>
      </View>
    </View>
  )

  const composerFor = (
    target: { projectId: string; projectName: string },
    session: IslandChatSession | null,
    initialFiles?: IslandFileRef[],
  ) => (
    <IslandComposer
      key={session ? `chat:${session.sessionId}` : `new:${target.projectId}`}
      ref={composerRef}
      bridge={bridge}
      initialFiles={initialFiles}
      placeholder={session ? `Reply in ${target.projectName}…` : `New chat in ${target.projectName}…`}
      isStreaming={session?.isStreaming ?? false}
      onFocus={focusForTyping}
      onDraftChange={(hasDraft) => {
        hasDraftRef.current = hasDraft
      }}
      onStop={session ? () => void session.stop() : undefined}
      onSend={async (text, files) => {
        const result = session
          ? await session.send(text, files, {
              interactionMode: ISLAND_INTERACTION_MODE,
            })
          : await startNewChat(target.projectId, target.projectName, {
              text,
              files,
            })
        if (result.ok && session && layout.sounds) playIslandSound("sent", layout.soundVolume)
        return result
      }}
      targetChip={
        view.name === "inbox" ? (
          <Pressable
            onPress={() => setPickerOpen((open) => !open)}
            className="flex-row items-center gap-1 rounded-full bg-white/10 px-2 py-0.5"
          >
            <Text className="max-w-[140px] text-[10px] font-medium text-zinc-300" numberOfLines={1}>
              {target.projectName}
            </Text>
            <ChevronsUpDown size={9} color="#a1a1aa" />
          </Pressable>
        ) : null
      }
    />
  )

  let body: React.ReactNode
  if (view.name === "drop") {
    body = (
      <IslandDropSheet
        files={view.files}
        projects={sortedProjects}
        initialProjectId={currentProjectId}
        canAttach={view.returnTo.name === "chat" || view.returnTo.name === "project"}
        onAction={(action, projectId) => handleDrop(action, projectId, view.files, view.returnTo)}
        onCancel={() => setView(view.returnTo)}
      />
    )
  } else if (view.name === "project") {
    body = (
      <>
        <SessionList
          projectId={view.projectId}
          liveSessions={snapshot.sessions}
          onOpen={(sessionId) => {
            const live = snapshot.sessions.find((s) => s.sessionId === sessionId)
            openChat(view.projectId, view.projectName, sessionId, live?.title ?? "Chat")
          }}
          onNewChat={() => composerRef.current?.focus()}
        />
        {composerFor(view, null, view.initialFiles)}
      </>
    )
  } else if (view.name === "chat") {
    const live = snapshot.sessions.find((s) => s.projectId === view.projectId && s.sessionId === view.sessionId)
    body = (
      <IslandChatHost
        live={live}
        initialSend={view.initialSend}
        context={{
          bridge,
          projectId: view.projectId,
          sessionId: view.sessionId,
          workspaceId,
          userId,
          modelId,
          interactionMode: ISLAND_INTERACTION_MODE,
        }}
      >
        {(session) => {
          pendingRef.current = !!session.permission || !!session.question
          return (
            <>
              <IslandConversation
                messages={session.messages}
                isStreaming={session.isStreaming}
                isLoading={session.isLoading}
                liveReply={session.liveReply}
                step={session.step}
                footer={
                  <>
                    {session.permission ? (
                      <PermissionCard permission={session.permission} onRespond={session.respondPermission} />
                    ) : null}
                    {session.question ? (
                      <QuestionCard
                        question={session.question}
                        onAnswer={session.answerQuestion}
                        onOpenInApp={() => openInShogo(view.projectId, view.sessionId)}
                      />
                    ) : null}
                    {session.plan && !session.isStreaming ? (
                      <IslandPlanReview
                        plan={session.plan}
                        modelId={modelId}
                        isPro={usage.hasAdvancedModelAccess}
                        onBuild={session.buildPlan}
                        onFeedback={session.sendPlanFeedback}
                        onOpenInApp={() => openInShogo(view.projectId, view.sessionId)}
                        onInputFocus={focusForTyping}
                      />
                    ) : null}
                    {session.error ? <Text className="text-[11px] text-rose-400">{session.error}</Text> : null}
                  </>
                }
              />
              {composerFor(view, session, view.initialFiles)}
            </>
          )
        }}
      </IslandChatHost>
    )
  } else {
    pendingRef.current = false
    body = (
      <>
        <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ padding: 8 }}>
          {orderedSessions.length > 0 ? (
            <>
              <Text className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Active</Text>
              {orderedSessions.map((session) => (
                <SessionRow
                  key={islandSessionKey(session.projectId, session.sessionId)}
                  row={{
                    title: session.title,
                    status: session.status,
                    activity: session.lastActivityAt ?? 0,
                    step: session.step,
                    replyPreview: session.replyPreview,
                  }}
                  subtitle={`${session.projectName}${session.step && session.status === "running" ? ` · ${session.step}` : ""}`}
                  onPress={() => openChat(session.projectId, session.projectName, session.sessionId, session.title)}
                />
              ))}
            </>
          ) : null}
          {orderedSessions.length === 0 ? (
            <Text className="px-2 py-4 text-center text-[12px] text-zinc-500">
              Nothing running. Start a chat below.
            </Text>
          ) : null}
        </ScrollView>
        {currentProjectId ? composerFor({ projectId: currentProjectId, projectName: currentProjectName }, null) : null}
      </>
    )
  }

  const message = notice ?? snapshot.notice
  const headerHeight = layout.notched ? layout.topInset : 40
  // The card is sized to its content, so an open dropdown reserves its own
  // room rather than being clipped by a short card.
  const pickerMinHeight = pickerOpen ? headerHeight + PICKER_HEIGHT + 12 : undefined
  // Notched: the card starts as the idle wings and unfolds downward, so it
  // reads as the notch opening. Elsewhere it unfolds from the virtual-notch tab.
  const folded = layout.notched
    ? {
        scaleX: Math.min(1, IDLE_NOTCHED_WIDTH / Math.max(windowWidth, 1)),
        scaleY: 0.08,
        opacity: 1,
      }
    : {
        scaleX: IDLE_TAB_WIDTH / Math.max(windowWidth, 1),
        scaleY: IDLE_TAB_HEIGHT / Math.max(maxCardHeight, 1),
        opacity: 1,
      }
  const unfolded = { scaleX: 1, scaleY: 1, opacity: 1 }
  return (
    <View className="dark" style={{ width: "100%", alignItems: "center" }}>
      <Motion.View
        key="island-card"
        initial={reducedMotion ? undefined : folded}
        animate={closing ? folded : unfolded}
        transition={islandMotion(reducedMotion, closing ? ISLAND_CLOSE : ISLAND_OPEN)}
        transformOrigin={{ x: "50%", y: 0 }}
        style={{ width: "100%" }}
      >
        <View
          {...ISLAND_SURFACE_PROPS}
          onLayout={onCardLayout}
          className={cn(
            "w-full overflow-hidden bg-black",
            layout.notched ? "rounded-b-[22px]" : "rounded-[22px] border border-white/10",
          )}
          style={{ maxHeight: maxCardHeight, minHeight: pickerMinHeight }}
        >
          <Motion.View
            initial={reducedMotion ? undefined : { opacity: 0 }}
            animate={{ opacity: closing ? 0 : 1 }}
            transition={islandMotion(reducedMotion, closing ? ISLAND_CONTENT_OUT : ISLAND_CONTENT_IN)}
            style={{ flexShrink: 1, minHeight: 0 }}
          >
            {header}
            {usageOpen ? (
              <View className="px-3 pb-2">
                <IslandUsagePanel usage={usage} onOpenBilling={openBilling} />
              </View>
            ) : null}
            {message ? <Text className="px-4 pb-1 text-[11px] text-amber-300">{message}</Text> : null}
            <IslandMeetingBanner
              meeting={meeting}
              notes={meetingNotes}
              onDecision={respondToMeeting}
              onOpenMeetings={openMeetings}
              onOpenMeeting={openMeeting}
            />
            <View style={{ flexShrink: 1, minHeight: 0 }}>{body}</View>
          </Motion.View>
          {pickerOpen ? (
            <>
              <Pressable
                onPress={() => setPickerOpen(false)}
                accessibilityLabel="Close project picker"
                style={{
                  position: "absolute",
                  top: headerHeight,
                  left: 0,
                  right: 0,
                  bottom: 0,
                }}
              />
              <Motion.View
                initial={reducedMotion ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={islandMotion(reducedMotion, ISLAND_HOVER)}
                transformOrigin={{ x: 0, y: 0 }}
                style={{
                  position: "absolute",
                  top: headerHeight,
                  left: 8,
                  width: Math.min(PICKER_WIDTH, windowWidth - 16),
                  maxHeight: PICKER_HEIGHT,
                }}
              >
                <View
                  className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-2xl"
                  style={{ maxHeight: PICKER_HEIGHT }}
                >
                  <ProjectSwitcher
                    workspaceId={workspaceId}
                    liveSessions={snapshot.sessions}
                    currentProjectId={currentProjectId}
                    onInputFocus={focusForTyping}
                    onSelect={(project: IslandProjectItem) => {
                      setPickerOpen(false)
                      setView({
                        name: "project",
                        projectId: project.id,
                        projectName: project.name,
                      })
                    }}
                  />
                </View>
              </Motion.View>
            </>
          ) : null}
        </View>
      </Motion.View>
    </View>
  )
})
