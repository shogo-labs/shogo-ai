// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FoldersPanel
 *
 * Project context manager. Two sections, available for every project:
 *
 *   - Linked folders — local host folders mounted into the project's
 *     anchor merged-root runtime (add via the desktop native picker,
 *     remove non-primary). External projects also use the primary folder to
 *     host `.shogo/` and can promote folders.
 *   - Attached projects — other Shogo projects (same workspace) mounted as
 *     subfolders of the same merged-root runtime so the agent can read /
 *     (optionally) edit across them. Add via the project picker; detach
 *     per-row; read-only attachments are write-protected by the runtime.
 *
 * Changing either set restarts the anchor merged-root runtime server-side
 * (LINKED_FOLDERS / READONLY_ROOTS are parsed once at boot), so the panel
 * shows a transient "Restarting context…" state after a change.
 *
 * External projects also get Workspace Trust + an "External preview URL"
 * control (their own dev server).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Boxes,
  Folder,
  FolderPlus,
  FolderTree,
  Globe,
  Plus,
  Star,
  StarOff,
  Trash2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react-native'
import { useDomainHttp, useProjectCollection } from '../../../contexts/domain'
import { api, API_URL } from '../../../lib/api'

interface ProjectFolder {
  id: string
  path: string
  isPrimary: boolean
  addedAt?: string
  lastOpenedAt?: string | null
}

interface ProjectShape {
  id: string
  name?: string
  workspaceId?: string
  workingMode?: 'managed' | 'external'
  trustLevel?: 'trusted' | 'restricted'
  projectFolders?: ProjectFolder[]
}

interface AttachmentShape {
  id: string
  attachedProjectId: string
  attachedProjectName: string | null
  attachMode: 'readwrite' | 'readonly'
}

interface FoldersPanelProps {
  projectId: string
  visible: boolean
  /**
   * Called when the user changes folder/attachment state so the parent
   * (project page) can re-query and refresh peripheral UI (file tree, etc.).
   */
  onChange?: () => void
}

export function FoldersPanel({ projectId, visible, onChange }: FoldersPanelProps) {
  const http = useDomainHttp()
  const projectCollection = useProjectCollection()
  const [project, setProject] = useState<ProjectShape | null>(null)
  const [attachments, setAttachments] = useState<AttachmentShape[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [previewSavedUrl, setPreviewSavedUrl] = useState<string | null>(null)
  const [previewDetectedUrl, setPreviewDetectedUrl] = useState<string | null>(null)
  const [previewDraft, setPreviewDraft] = useState<string>('')

  // Native picker handle. Only present in Electron desktop.
  const desktop = useMemo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null
    return (window as any).shogoDesktop as
      | { pickFolders?: (opts?: { multi?: boolean }) => Promise<any> }
      | null
  }, [])

  const refresh = useCallback(async () => {
    if (!projectId) return
    setIsLoading(true)
    setError(null)
    try {
      const { project: p, attachments: att } = await api.getLocalProjectWithAttachments(http, projectId)
      setProject(p)
      setAttachments(att)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load folders')
    } finally {
      setIsLoading(false)
    }
  }, [http, projectId])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  const isExternal = project?.workingMode === 'external'
  const folders = project?.projectFolders ?? []

  // Signal that the merged-root runtime is being remounted, then clear when it
  // reports healthy again. A read-only attach (and any member change) triggers
  // an env-coupled restart on the server; rather than guess with a fixed
  // timer, poll the runtime-status endpoint until `ready` so the indicator
  // reflects actual readiness. A token guards against overlapping restarts
  // (the latest one owns the indicator).
  const restartTokenRef = useRef(0)
  const flagRestart = useCallback(() => {
    if (!projectId) return
    const token = ++restartTokenRef.current
    setRestarting(true)
    void (async () => {
      const deadline = Date.now() + 20_000
      // Let the server tear the old runtime down first so we don't observe the
      // pre-restart 'ready' and clear too early.
      await new Promise((r) => setTimeout(r, 800))
      while (restartTokenRef.current === token && Date.now() < deadline) {
        const status = await api.getWorkspaceRuntimeStatus(http, projectId)
        if (status.ready) break
        await new Promise((r) => setTimeout(r, 700))
      }
      if (restartTokenRef.current === token) setRestarting(false)
    })()
  }, [http, projectId])

  // Candidate projects for the "Add project" picker: same workspace, not
  // this project, not already attached.
  const attachCandidates = useMemo(() => {
    let all: Array<{ id: string; name: string; workspaceId: string }> = []
    try {
      all = (projectCollection?.all?.slice() ?? []) as any[]
    } catch {
      all = []
    }
    const attachedIds = new Set(attachments.map((a) => a.attachedProjectId))
    return all.filter(
      (p) =>
        p.id !== projectId &&
        attachedIds.has(p.id) === false &&
        (!project?.workspaceId || p.workspaceId === project.workspaceId),
    )
  }, [projectCollection?.all, attachments, projectId, project?.workspaceId])

  // ─── Preview URL polling (external only) ───────────────────────────
  useEffect(() => {
    if (!visible || !isExternal || !projectId) return
    let cancelled = false
    const fetchPreview = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/projects/${encodeURIComponent(projectId)}/external-preview`,
          { credentials: Platform.OS === 'web' ? 'include' : 'omit' },
        )
        if (!res.ok) return
        const body = await res.json()
        if (cancelled) return
        const saved = typeof body?.savedUrl === 'string' ? body.savedUrl : null
        const detected = typeof body?.detectedUrl === 'string' ? body.detectedUrl : null
        setPreviewSavedUrl(saved)
        setPreviewDetectedUrl(detected)
        setPreviewDraft((prev) => prev || saved || detected || '')
      } catch {
        /* best-effort */
      }
    }
    void fetchPreview()
    const t = setInterval(fetchPreview, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [visible, isExternal, projectId])

  const handleSavePreviewUrl = useCallback(
    async (url: string) => {
      const trimmed = url.trim()
      if (!trimmed) return
      const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
      setBusy('preview-url')
      try {
        const res = await fetch(
          `${API_URL}/api/projects/${encodeURIComponent(projectId)}/external-preview`,
          {
            method: 'PUT',
            credentials: Platform.OS === 'web' ? 'include' : 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ savedUrl: withProto }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(String(body?.error ?? `HTTP ${res.status}`))
          return
        }
        const body = await res.json().catch(() => ({}))
        if (typeof body?.savedUrl === 'string') {
          setPreviewSavedUrl(body.savedUrl)
          setPreviewDraft(body.savedUrl)
        }
        onChange?.()
      } catch (err: any) {
        setError(err?.message ?? 'Failed to save preview URL')
      } finally {
        setBusy(null)
      }
    },
    [projectId, onChange],
  )

  const handleClearPreviewUrl = useCallback(async () => {
    setBusy('preview-url')
    try {
      const res = await fetch(
        `${API_URL}/api/projects/${encodeURIComponent(projectId)}/external-preview`,
        { method: 'DELETE', credentials: Platform.OS === 'web' ? 'include' : 'omit' },
      )
      if (res.ok) {
        setPreviewSavedUrl(null)
        setPreviewDraft('')
        onChange?.()
      }
    } catch {
      /* best-effort */
    } finally {
      setBusy(null)
    }
  }, [projectId, onChange])

  // ─── Linked folders ────────────────────────────────────────────────
  const handleAddFolder = useCallback(async () => {
    if (!desktop?.pickFolders) return
    setBusy('add-folder')
    try {
      const picked = await desktop.pickFolders({ multi: true })
      if (!picked?.ok || !Array.isArray(picked.paths)) return
      for (const path of picked.paths) {
        const r = await api.addProjectFolder(http, projectId, path)
        if (r.error) setError(r.error)
      }
      await refresh()
      flagRestart()
      onChange?.()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to add folder')
    } finally {
      setBusy(null)
    }
  }, [desktop, http, projectId, refresh, flagRestart, onChange])

  const handleRemoveFolder = useCallback(
    async (folderId: string) => {
      setBusy(`remove-folder-${folderId}`)
      try {
        const r = await api.removeProjectFolder(http, projectId, folderId)
        if (r.error) setError(r.error)
        await refresh()
        flagRestart()
        onChange?.()
      } catch (err: any) {
        setError(err?.message ?? 'Failed to remove folder')
      } finally {
        setBusy(null)
      }
    },
    [http, projectId, refresh, flagRestart, onChange],
  )

  const handlePromote = useCallback(
    async (folderId: string) => {
      setBusy(`primary-${folderId}`)
      try {
        await http.post(`/api/local/projects/${encodeURIComponent(projectId)}/primary`, { folderId })
        await refresh()
        onChange?.()
      } catch (err: any) {
        setError(err?.message ?? 'Failed to set primary folder')
      } finally {
        setBusy(null)
      }
    },
    [http, projectId, refresh, onChange],
  )

  // ─── Attached projects ─────────────────────────────────────────────
  const handleAttachProject = useCallback(
    async (attachedProjectId: string, mode: 'readwrite' | 'readonly' = 'readwrite') => {
      setBusy(`attach-${attachedProjectId}`)
      try {
        const r = await api.attachProjectToProject(http, projectId, attachedProjectId, mode)
        if (r.error) {
          setError(r.error)
          return
        }
        setPickerOpen(false)
        await refresh()
        flagRestart()
        onChange?.()
      } finally {
        setBusy(null)
      }
    },
    [http, projectId, refresh, flagRestart, onChange],
  )

  const handleDetachProject = useCallback(
    async (attachedProjectId: string) => {
      setBusy(`detach-${attachedProjectId}`)
      try {
        const r = await api.detachProjectFromProject(http, projectId, attachedProjectId)
        if (r.error) setError(r.error)
        await refresh()
        flagRestart()
        onChange?.()
      } finally {
        setBusy(null)
      }
    },
    [http, projectId, refresh, flagRestart, onChange],
  )

  const handleToggleTrust = useCallback(async () => {
    if (!project) return
    const next = project.trustLevel === 'trusted' ? false : true
    setBusy('trust')
    try {
      await http.post(`/api/local/projects/${encodeURIComponent(projectId)}/trust`, { trusted: next })
      await refresh()
      onChange?.()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update trust')
    } finally {
      setBusy(null)
    }
  }, [http, projectId, project, refresh, onChange])

  if (!visible) return null

  return (
    <View
      testID="folders-panel"
      className="absolute inset-0 flex-col bg-background"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <View className="px-4 py-3 border-b border-border flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <FolderTree size={16} className="text-muted-foreground" />
          <Text className="text-sm font-semibold text-foreground">Folders & projects</Text>
        </View>
        {restarting ? (
          <View testID="runtime-restarting" className="flex-row items-center gap-1.5">
            <ActivityIndicator size="small" />
            <Text className="text-[11px] text-muted-foreground">Restarting context…</Text>
          </View>
        ) : null}
      </View>

      {isLoading && !project ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="pb-6">
          {/* Trust banner (external only). */}
          {isExternal ? (
            project?.trustLevel === 'restricted' ? (
              <View className="mx-4 mt-3 rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 flex-row items-start gap-2">
                <ShieldAlert size={16} className="text-amber-600 mt-0.5" />
                <View className="flex-1">
                  <Text className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    Workspace is restricted
                  </Text>
                  <Text className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                    Edits and shell commands are blocked until you trust this folder.
                  </Text>
                </View>
                <Pressable
                  testID="trust-folder-button"
                  onPress={handleToggleTrust}
                  disabled={busy === 'trust'}
                  className={cn(
                    'rounded-md bg-amber-600 px-2.5 py-1',
                    busy === 'trust' ? 'opacity-60' : 'active:opacity-80',
                  )}
                >
                  <Text className="text-[11px] font-medium text-white">Trust folder</Text>
                </Pressable>
              </View>
            ) : (
              <View className="mx-4 mt-3 rounded-lg border border-emerald-200/60 bg-emerald-50/50 dark:bg-emerald-900/10 px-3 py-2 flex-row items-center gap-2">
                <ShieldCheck size={14} className="text-emerald-600" />
                <Text className="text-[11px] text-emerald-700 dark:text-emerald-300 flex-1">
                  Workspace trusted — edits and shell allowed.
                </Text>
                <Pressable onPress={handleToggleTrust} disabled={busy === 'trust'} className="active:opacity-60">
                  <Text className="text-[11px] text-muted-foreground underline">Restrict</Text>
                </Pressable>
              </View>
            )
          ) : null}

          {error ? (
            <View testID="folders-error" className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2">
              <Text className="text-xs text-destructive">{error}</Text>
            </View>
          ) : null}

          {/* ─── Linked folders ─────────────────────────────────────── */}
          <View className="px-4 mt-4">
            <View className="flex-row items-center justify-between mb-2">
              <View className="flex-row items-center gap-1.5">
                <Folder size={13} className="text-muted-foreground" />
                <Text className="text-xs font-semibold text-foreground">Linked folders</Text>
                {folders.length > 0 ? (
                  <View className="bg-muted rounded-full px-1.5 py-0.5">
                    <Text className="text-[10px] font-medium text-muted-foreground">{folders.length}</Text>
                  </View>
                ) : null}
              </View>
              {desktop?.pickFolders ? (
                <Pressable
                  testID="folders-add-folder"
                  onPress={handleAddFolder}
                  disabled={busy !== null}
                  className={cn(
                    'flex-row items-center gap-1.5 rounded-lg px-2.5 py-1',
                    busy === 'add-folder' ? 'bg-muted' : 'bg-primary active:opacity-80',
                  )}
                >
                  <FolderPlus
                    size={13}
                    className={busy === 'add-folder' ? 'text-muted-foreground' : 'text-primary-foreground'}
                  />
                  <Text
                    className={cn(
                      'text-[11px] font-medium',
                      busy === 'add-folder' ? 'text-muted-foreground' : 'text-primary-foreground',
                    )}
                  >
                    Add folder
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {folders.length === 0 ? (
              <View className="rounded-lg border border-dashed border-border px-4 py-5 items-center">
                <Text className="text-[11px] text-muted-foreground text-center">
                  {desktop?.pickFolders
                    ? 'No folders linked. Add a folder on your machine to give the agent access.'
                    : 'Folder linking is available in the Shogo desktop app.'}
                </Text>
              </View>
            ) : (
              <View className="gap-2">
                {folders.map((folder) => (
                  <View
                    key={folder.id}
                    testID={`linked-folder-${folder.id}`}
                    className="rounded-lg border border-border bg-card px-3 py-2.5 flex-row items-start gap-2"
                  >
                    <View className="mt-0.5">
                      {folder.isPrimary ? (
                        <Star size={16} className="text-amber-500" />
                      ) : (
                        <Folder size={16} className="text-muted-foreground" />
                      )}
                    </View>
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                          {basename(folder.path)}
                        </Text>
                        {folder.isPrimary ? (
                          <View className="rounded-full bg-amber-100 dark:bg-amber-900/30 px-1.5 py-0.5">
                            <Text className="text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                              Primary
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text className="text-[11px] text-muted-foreground font-mono mt-0.5" numberOfLines={1}>
                        {folder.path}
                      </Text>
                    </View>
                    <View className="flex-row items-center gap-1">
                      {isExternal && !folder.isPrimary ? (
                        <Pressable
                          onPress={() => handlePromote(folder.id)}
                          disabled={busy !== null}
                          className="rounded-md px-2 py-1 active:bg-muted"
                        >
                          {busy === `primary-${folder.id}` ? (
                            <ActivityIndicator size="small" />
                          ) : (
                            <Star size={13} className="text-muted-foreground" />
                          )}
                        </Pressable>
                      ) : isExternal ? (
                        <View className="rounded-md px-2 py-1 opacity-40">
                          <StarOff size={13} className="text-muted-foreground" />
                        </View>
                      ) : null}
                      {!folder.isPrimary ? (
                        <Pressable
                          testID={`remove-folder-${folder.id}`}
                          onPress={() => handleRemoveFolder(folder.id)}
                          disabled={busy !== null}
                          className="rounded-md px-2 py-1 active:bg-destructive/10"
                        >
                          {busy === `remove-folder-${folder.id}` ? (
                            <ActivityIndicator size="small" />
                          ) : (
                            <Trash2 size={13} className="text-destructive" />
                          )}
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* ─── Attached projects ──────────────────────────────────── */}
          <View className="px-4 mt-5">
            <View className="flex-row items-center justify-between mb-2">
              <View className="flex-row items-center gap-1.5">
                <Boxes size={13} className="text-muted-foreground" />
                <Text className="text-xs font-semibold text-foreground">Attached projects</Text>
                {attachments.length > 0 ? (
                  <View className="bg-muted rounded-full px-1.5 py-0.5">
                    <Text className="text-[10px] font-medium text-muted-foreground">{attachments.length}</Text>
                  </View>
                ) : null}
              </View>
              <Pressable
                testID="attachments-add-project"
                onPress={() => setPickerOpen((v) => !v)}
                disabled={busy !== null}
                className="flex-row items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 active:opacity-80"
              >
                <Plus size={13} className="text-primary-foreground" />
                <Text className="text-[11px] font-medium text-primary-foreground">Add project</Text>
              </Pressable>
            </View>

            {pickerOpen ? (
              <View
                testID="attach-picker"
                className="mb-2 rounded-lg border border-border bg-card overflow-hidden"
              >
                {attachCandidates.length === 0 ? (
                  <View className="px-3 py-4 items-center">
                    <Text className="text-[11px] text-muted-foreground text-center">
                      No other projects in this workspace to attach.
                    </Text>
                  </View>
                ) : (
                  attachCandidates.map((p) => (
                    <Pressable
                      key={p.id}
                      testID={`attach-pick-${p.id}`}
                      onPress={() => handleAttachProject(p.id)}
                      disabled={busy !== null}
                      className="flex-row items-center gap-2 px-3 py-2.5 border-b border-border active:bg-muted"
                    >
                      <Boxes size={14} className="text-muted-foreground" />
                      <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
                        {p.name || p.id}
                      </Text>
                      {busy === `attach-${p.id}` ? <ActivityIndicator size="small" /> : null}
                    </Pressable>
                  ))
                )}
              </View>
            ) : null}

            {attachments.length === 0 ? (
              <View className="rounded-lg border border-dashed border-border px-4 py-5 items-center">
                <Text className="text-[11px] text-muted-foreground text-center">
                  Attach another project to read and edit across both in the same chat.
                </Text>
              </View>
            ) : (
              <View className="gap-2">
                {attachments.map((att) => (
                  <View
                    key={att.id}
                    testID={`attached-project-${att.attachedProjectId}`}
                    className="rounded-lg border border-border bg-card px-3 py-2.5 flex-row items-center gap-2"
                  >
                    <Boxes size={16} className="text-muted-foreground" />
                    <View className="flex-1">
                      <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
                        {att.attachedProjectName || att.attachedProjectId}
                      </Text>
                      <Text className="text-[10px] text-muted-foreground mt-0.5">
                        {att.attachMode === 'readonly' ? 'Read-only' : 'Read / write'}
                      </Text>
                    </View>
                    <Pressable
                      testID={`toggle-mode-${att.attachedProjectId}`}
                      onPress={() =>
                        handleAttachProject(
                          att.attachedProjectId,
                          att.attachMode === 'readonly' ? 'readwrite' : 'readonly',
                        )
                      }
                      disabled={busy !== null}
                      className="rounded-md px-2 py-1 active:bg-muted"
                    >
                      <Text className="text-[10px] text-muted-foreground underline">
                        {att.attachMode === 'readonly' ? 'Allow edits' : 'Make read-only'}
                      </Text>
                    </Pressable>
                    <Pressable
                      testID={`detach-project-${att.attachedProjectId}`}
                      onPress={() => handleDetachProject(att.attachedProjectId)}
                      disabled={busy !== null}
                      className="rounded-md px-2 py-1 active:bg-destructive/10"
                    >
                      {busy === `detach-${att.attachedProjectId}` ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <Trash2 size={13} className="text-destructive" />
                      )}
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* External preview URL (external only). */}
          {isExternal ? (
            <View className="mx-4 mt-5 rounded-lg border border-border bg-card px-3 py-3 gap-2">
              <View className="flex-row items-start gap-2">
                <Globe size={16} className="text-muted-foreground mt-0.5" />
                <View className="flex-1">
                  <Text className="text-xs font-medium text-foreground">External preview URL</Text>
                  <Text className="text-[11px] text-muted-foreground mt-0.5">
                    Tell Shogo where your dev server is running. Only local hosts (localhost, 127.0.0.1) are allowed.
                  </Text>
                </View>
              </View>
              <View className="flex-row items-center gap-2">
                <View className="flex-1 flex-row items-center rounded-md bg-muted px-2 py-1">
                  <TextInput
                    value={previewDraft}
                    onChangeText={setPreviewDraft}
                    placeholder="http://localhost:3000"
                    placeholderTextColor="rgba(115,115,115,0.7)"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    spellCheck={false}
                    className="flex-1 text-[11px] text-foreground"
                    style={{ paddingVertical: 0 } as any}
                    onSubmitEditing={() => handleSavePreviewUrl(previewDraft)}
                  />
                </View>
                <Pressable
                  onPress={() => handleSavePreviewUrl(previewDraft)}
                  disabled={busy === 'preview-url' || !previewDraft.trim()}
                  className={cn(
                    'rounded-md bg-primary px-2.5 py-1',
                    busy === 'preview-url' || !previewDraft.trim() ? 'opacity-60' : 'active:opacity-80',
                  )}
                >
                  <Text className="text-[11px] font-medium text-primary-foreground">Save</Text>
                </Pressable>
                {previewSavedUrl ? (
                  <Pressable
                    onPress={handleClearPreviewUrl}
                    disabled={busy === 'preview-url'}
                    className="rounded-md px-2 py-1 active:bg-muted"
                  >
                    <Text className="text-[11px] text-muted-foreground underline">Clear</Text>
                  </Pressable>
                ) : null}
              </View>
              {previewDetectedUrl && previewDetectedUrl !== previewSavedUrl ? (
                <View className="flex-row items-center gap-2">
                  <Text className="text-[10px] text-muted-foreground flex-1" numberOfLines={1}>
                    Detected from terminal: <Text className="font-mono text-foreground">{previewDetectedUrl}</Text>
                  </Text>
                  <Pressable
                    onPress={() => handleSavePreviewUrl(previewDetectedUrl)}
                    disabled={busy === 'preview-url'}
                    className="rounded-md bg-emerald-500/10 px-2 py-0.5 active:opacity-80"
                  >
                    <Text className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                      Use this
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  )
}

function basename(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}
