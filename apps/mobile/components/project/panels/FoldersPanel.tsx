// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FoldersPanel
 *
 * VS Code-style folder management for external (workingMode='external')
 * projects. Lists every linked folder, lets the user add more via the
 * native picker, mark a folder primary (where `.shogo/` lives), or
 * remove non-primary folders.
 *
 * Banner behaviour:
 *   - When `runtimeEnabled === false`, render an "Enable preview" prompt
 *     explaining that the Vite/Metro dev server is off by default and
 *     offering a switch to opt in. We deliberately don't auto-run
 *     `bun install` for the user — see plan §5, "respect their package
 *     manager".
 *   - When the project isn't external mode at all, render an
 *     informational empty state instead of nothing — saves the user
 *     wondering why the panel is blank if they navigated here from a
 *     managed project.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Folder,
  FolderPlus,
  FolderTree,
  Star,
  StarOff,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  PlaySquare,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../contexts/domain'
import { API_URL } from '../../../lib/api'

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
  workingMode?: 'managed' | 'external'
  runtimeEnabled?: boolean
  trustLevel?: 'trusted' | 'restricted'
  projectFolders?: ProjectFolder[]
}

interface FoldersPanelProps {
  projectId: string
  visible: boolean
  /**
   * Called when the user changes folder state so the parent (project
   * page) can re-query and refresh peripheral UI (file tree, etc.).
   * Optional — the panel does its own state sync regardless.
   */
  onChange?: () => void
}

export function FoldersPanel({ projectId, visible, onChange }: FoldersPanelProps) {
  const http = useDomainHttp()
  const [project, setProject] = useState<ProjectShape | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Native picker handle. Only present in Electron. We capture it
  // lazily so the panel works in a regular browser (the buttons are
  // disabled with a hint instead of crashing).
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
      // The generated /api/projects/:id route already returns
      // projectFolders via the include relation (model registered in
      // shogo.config.json). We use the raw fetch path to bypass any
      // collection store caching — folder state must reflect on the
      // next render.
      const res = await fetch(`${API_URL}/api/projects/${encodeURIComponent(projectId)}?include=projectFolders`, {
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
      })
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        return
      }
      const data: any = await res.json()
      setProject(data?.project ?? data ?? null)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load folders')
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  const isExternal = project?.workingMode === 'external'
  const folders = project?.projectFolders ?? []

  const handleAdd = useCallback(async () => {
    if (!desktop?.pickFolders) return
    setBusy('add')
    try {
      const picked = await desktop.pickFolders({ multi: true })
      if (!picked?.ok || !Array.isArray(picked.paths)) return
      for (const path of picked.paths) {
        await http.post(`/api/local/projects/${encodeURIComponent(projectId)}/folders`, { path })
      }
      await refresh()
      onChange?.()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to add folder')
    } finally {
      setBusy(null)
    }
  }, [desktop, http, projectId, refresh, onChange])

  const handleRemove = useCallback(
    async (folderId: string) => {
      setBusy(`remove-${folderId}`)
      try {
        await http.delete(`/api/local/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`)
        await refresh()
        onChange?.()
      } catch (err: any) {
        setError(err?.message ?? 'Failed to remove folder')
      } finally {
        setBusy(null)
      }
    },
    [http, projectId, refresh, onChange],
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

  const handleEnablePreview = useCallback(async () => {
    setBusy('runtime')
    try {
      // No dedicated route yet — flip `runtimeEnabled` via the generated
      // /api/projects/:id PATCH route (Project model owns the column).
      await http.patch(`/api/projects/${encodeURIComponent(projectId)}`, {
        runtimeEnabled: true,
      })
      // Kick a runtime start so the agent picks up Vite/Metro on next
      // chat turn without waiting for the user to send a message.
      try {
        await http.post(`/api/projects/${encodeURIComponent(projectId)}/runtime/start`, {})
      } catch {
        /* best-effort */
      }
      await refresh()
      onChange?.()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to enable preview')
    } finally {
      setBusy(null)
    }
  }, [http, projectId, refresh, onChange])

  const handleToggleTrust = useCallback(async () => {
    if (!project) return
    const next = project.trustLevel === 'trusted' ? false : true
    setBusy('trust')
    try {
      await http.post(`/api/local/projects/${encodeURIComponent(projectId)}/trust`, {
        trusted: next,
      })
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
    <View className="absolute inset-0 flex-col bg-background" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <FolderTree size={16} className="text-muted-foreground" />
          <Text className="text-sm font-semibold text-foreground">Folders</Text>
          {folders.length > 0 && (
            <View className="bg-muted rounded-full px-1.5 py-0.5">
              <Text className="text-[10px] font-medium text-muted-foreground">{folders.length}</Text>
            </View>
          )}
        </View>
        {isExternal && desktop?.pickFolders ? (
          <Pressable
            onPress={handleAdd}
            disabled={busy !== null}
            className={cn(
              'flex-row items-center gap-1.5 rounded-lg px-3 py-1.5',
              busy === 'add' ? 'bg-muted' : 'bg-primary active:opacity-80',
            )}
          >
            <FolderPlus size={14} className={busy === 'add' ? 'text-muted-foreground' : 'text-primary-foreground'} />
            <Text
              className={cn(
                'text-xs font-medium',
                busy === 'add' ? 'text-muted-foreground' : 'text-primary-foreground',
              )}
            >
              Add folder
            </Text>
          </Pressable>
        ) : null}
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="small" />
        </View>
      ) : !isExternal ? (
        <View className="flex-1 items-center justify-center px-6">
          <Folder size={28} className="text-muted-foreground mb-3" />
          <Text className="text-base font-semibold text-foreground mb-1 text-center">
            Managed project
          </Text>
          <Text className="text-sm text-muted-foreground text-center">
            This project lives in Shogo's managed workspace, not a folder on your machine.
            Folder linking is available for "Open Folder…" projects only.
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="pb-6">
          {/* Trust banner — sticky reminder of restricted mode. */}
          {project?.trustLevel === 'restricted' ? (
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
                onPress={handleToggleTrust}
                disabled={busy === 'trust'}
                className={cn(
                  'rounded-md bg-amber-600 px-2.5 py-1',
                  busy === 'trust' ? 'opacity-60' : 'active:opacity-80',
                )}
              >
                <Text className="text-[11px] font-medium text-white">Trust</Text>
              </Pressable>
            </View>
          ) : (
            <View className="mx-4 mt-3 rounded-lg border border-emerald-200/60 bg-emerald-50/50 dark:bg-emerald-900/10 px-3 py-2 flex-row items-center gap-2">
              <ShieldCheck size={14} className="text-emerald-600" />
              <Text className="text-[11px] text-emerald-700 dark:text-emerald-300 flex-1">
                Workspace trusted — edits and shell allowed.
              </Text>
              <Pressable
                onPress={handleToggleTrust}
                disabled={busy === 'trust'}
                className="active:opacity-60"
              >
                <Text className="text-[11px] text-muted-foreground underline">Revoke</Text>
              </Pressable>
            </View>
          )}

          {/* Preview opt-in banner. */}
          {project?.runtimeEnabled === false ? (
            <View className="mx-4 mt-3 rounded-lg border border-border bg-card px-3 py-3 flex-row items-start gap-2">
              <PlaySquare size={16} className="text-muted-foreground mt-0.5" />
              <View className="flex-1">
                <Text className="text-xs font-medium text-foreground">Live preview is off</Text>
                <Text className="text-[11px] text-muted-foreground mt-0.5">
                  Shogo won't run Vite or Metro inside your repo unless you opt in. We respect
                  your existing package manager.
                </Text>
              </View>
              <Pressable
                onPress={handleEnablePreview}
                disabled={busy === 'runtime'}
                className={cn(
                  'rounded-md bg-primary px-2.5 py-1',
                  busy === 'runtime' ? 'opacity-60' : 'active:opacity-80',
                )}
              >
                <Text className="text-[11px] font-medium text-primary-foreground">Enable preview</Text>
              </Pressable>
            </View>
          ) : null}

          {error ? (
            <View className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2">
              <Text className="text-xs text-destructive">{error}</Text>
            </View>
          ) : null}

          <View className="px-4 mt-4 gap-2">
            {folders.length === 0 ? (
              <View className="rounded-lg border border-dashed border-border px-4 py-6 items-center">
                <Folder size={24} className="text-muted-foreground mb-2" />
                <Text className="text-sm text-muted-foreground">No folders linked yet.</Text>
                {desktop?.pickFolders ? (
                  <Pressable
                    onPress={handleAdd}
                    className="mt-3 flex-row items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 active:opacity-80"
                  >
                    <FolderPlus size={14} className="text-primary-foreground" />
                    <Text className="text-xs font-medium text-primary-foreground">Add folder</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              folders.map((folder) => (
                <View
                  key={folder.id}
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
                    {!folder.isPrimary ? (
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
                    ) : (
                      <View className="rounded-md px-2 py-1 opacity-40">
                        <StarOff size={13} className="text-muted-foreground" />
                      </View>
                    )}
                    {!folder.isPrimary ? (
                      <Pressable
                        onPress={() => handleRemove(folder.id)}
                        disabled={busy !== null}
                        className="rounded-md px-2 py-1 active:bg-destructive/10"
                      >
                        {busy === `remove-${folder.id}` ? (
                          <ActivityIndicator size="small" />
                        ) : (
                          <Trash2 size={13} className="text-destructive" />
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ))
            )}
          </View>
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
