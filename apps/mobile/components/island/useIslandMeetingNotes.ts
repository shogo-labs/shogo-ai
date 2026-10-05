// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The island's meeting notepad. Notes typed while recording are saved to the
 * recording's draft meeting; after stop, the island watches that meeting
 * until the enhanced notes are written so it can offer to open them.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { API_URL } from "../../lib/api"
import { useLiveMeetingTranscript } from "../../lib/use-live-meeting-transcript"
import type { IslandMeetingState } from "./types"

type Recording = IslandMeetingState["recording"]

export interface IslandMeetingNotes {
  notes: string
  setNotes: (next: string) => void
  /** The last few words of the live transcript, while recording. */
  caption: string | null
  saving: boolean
  /** Set once the last recording's notes are written (or failed). */
  finished: { meetingId: string; title: string | null; ok: boolean } | null
  /** True between stop and `finished`. */
  processing: boolean
  dismissFinished: () => void
}

const SAVE_DEBOUNCE_MS = 600
const POLL_MS = 3000
const POLL_GIVE_UP_MS = 15 * 60 * 1000

function draftUrl(recordingId: string) {
  return `${API_URL}/api/local/meetings/recordings/${encodeURIComponent(recordingId)}`
}

/**
 * The desktop main process files live transcript chunks under the workspace
 * the app is showing; the island reads and writes the same one.
 */
let workspaceHint: string | null = null
const hintHeaders = (): Record<string, string> => (workspaceHint ? { "x-shogo-workspace-id": workspaceHint } : {})

async function loadWorkspaceHint() {
  const desktop = (window as unknown as { shogoDesktop?: { getMeetingsWorkspace?: () => Promise<string | null> } }).shogoDesktop
  workspaceHint = (await desktop?.getMeetingsWorkspace?.().catch(() => null)) ?? null
}

async function saveDraft(recordingId: string, body: { notes?: string; app?: string }) {
  const res = await fetch(draftUrl(recordingId), {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json", ...hintHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Saving notes failed (${res.status})`)
  return (await res.json()).meeting as { id: string; notes: string | null }
}

async function loadDraft(recordingId: string) {
  const res = await fetch(draftUrl(recordingId), { credentials: "include", headers: hintHeaders() })
  if (!res.ok) return null
  return (await res.json()).meeting as {
    id: string
    title: string | null
    notes: string | null
    status: string
    enhanceStatus: string
    transcript: string | null
  }
}

const CAPTION_CHARS = 140

export function captionFromText(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (text.length <= CAPTION_CHARS) return text
  const tail = text.slice(-CAPTION_CHARS)
  const firstSpace = tail.indexOf(" ")
  return `…${firstSpace > 0 ? tail.slice(firstSpace + 1) : tail}`
}

export function liveCaption(transcript: string | null | undefined): string | null {
  if (!transcript) return null
  try {
    return captionFromText(String(JSON.parse(transcript).text ?? ""))
  } catch {
    return null
  }
}

export function useIslandMeetingNotes(recording: Recording): IslandMeetingNotes {
  const [notes, setNotesState] = useState("")
  const [saving, setSaving] = useState(false)
  const [watching, setWatching] = useState<{ recordingId: string; since: number } | null>(null)
  const [finished, setFinished] = useState<IslandMeetingNotes["finished"]>(null)
  const [hintLoaded, setHintLoaded] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const activeId = useRef<string | null>(null)
  const recordingId = recording?.id

  const flush = useCallback(async (id: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const text = pending.current
    if (text === null) return
    pending.current = null
    setSaving(true)
    await saveDraft(id, { notes: text }).catch((err) => console.warn("[island] notes:", err?.message ?? err))
    setSaving(false)
  }, [])

  // Recording started: create the draft (so the app name sticks) and pick up
  // notes typed before the island was reopened.
  useEffect(() => {
    if (!recordingId) return
    const previous = activeId.current
    activeId.current = recordingId
    if (previous === recordingId) return
    setFinished(null)
    setWatching(null)
    setNotesState("")
    let cancelled = false
    setHintLoaded(false)
    // The workspace hint must be known before the first draft write, or the draft lands in the wrong workspace.
    void loadWorkspaceHint()
      .then(() => {
        setHintLoaded(true)
        return saveDraft(recordingId, recording?.app ? { app: recording.app } : {})
      })
      .then((draft) => {
        if (!cancelled && draft.notes && pending.current === null) setNotesState(draft.notes)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [recordingId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Recording stopped: save anything pending, then watch for the write-up.
  useEffect(() => {
    if (recordingId || !activeId.current) return
    const stoppedId = activeId.current
    activeId.current = null
    void flush(stoppedId)
    setWatching({ recordingId: stoppedId, since: Date.now() })
  }, [recordingId, flush])

  useEffect(() => {
    if (!watching) return
    let cancelled = false
    const tick = async () => {
      const meeting = await loadDraft(watching.recordingId).catch(() => null)
      if (cancelled) return
      const done =
        meeting &&
        (meeting.status === "error" ||
          (meeting.status === "ready" && ["ready", "error", "skipped"].includes(meeting.enhanceStatus)))
      if (meeting && done) {
        setFinished({
          meetingId: meeting.id,
          title: meeting.title,
          ok: meeting.status === "ready" && meeting.enhanceStatus === "ready",
        })
        setWatching(null)
      } else if (Date.now() - watching.since > POLL_GIVE_UP_MS) {
        setWatching(null)
      }
    }
    const timer = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watching])

  // While recording, the main process streams audio to the API and the words
  // arrive here as they are said (polling the draft where SSE isn't available).
  const pollDraft = useCallback(async () => {
    if (!recordingId) return null
    const meeting = await loadDraft(recordingId).catch(() => null)
    return meeting ? { transcript: meeting.transcript, status: meeting.status } : null
  }, [recordingId])
  const live = useLiveMeetingTranscript({
    url: recordingId && hintLoaded
      ? `${draftUrl(recordingId)}/live/events${workspaceHint ? `?workspace=${encodeURIComponent(workspaceHint)}` : ""}`
      : null,
    poll: pollDraft,
    pollMs: POLL_MS,
  })
  const caption = recordingId
    ? captionFromText([...live.segments.map((s) => s.text), live.partial ?? ""].filter(Boolean).join(" ")) ??
      live.notice
    : null

  const setNotes = useCallback(
    (next: string) => {
      setNotesState(next)
      const id = activeId.current
      if (!id) return
      pending.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void flush(id), SAVE_DEBOUNCE_MS)
    },
    [flush],
  )

  return {
    notes,
    setNotes,
    caption,
    saving,
    finished,
    processing: !!watching,
    dismissFinished: useCallback(() => setFinished(null), []),
  }
}
