// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useOpenCloudProject — shared logic for the "Open from Cloud…" project
 * flow (the cloud sibling of `useOpenLocalFolder`).
 *
 * Walks the user through:
 *   1. Listing the cloud projects the connected `SHOGO_API_KEY` can see
 *      (`GET /api/local/cloud-projects`).
 *   2. Linking + opening the picked one (`POST /api/local/cloud-projects/
 *      :id/open`), which creates/flags a local `Project` keyed by the
 *      cloud project id.
 *   3. Returning the resulting Project to the caller via `onSuccess`, or
 *      navigating to the project page when no callback is given.
 *
 * The actual workspace files materialize on the next runtime start: the
 * desktop runtime adapter auto-pulls the cloud contents (git clone /
 * Files API) and starts a `CloudSyncWatcher` that pushes local edits
 * back — see `apps/api/src/lib/runtime/cloud-content-sync.ts`.
 *
 * Availability mirrors how the "Open folder…" row gates on Electron:
 * this flow only makes sense in the desktop/local build with a connected
 * cloud key, so `isAvailable` is `localMode && shogoKeyConnected`. The
 * `/api/local/cloud-projects` route is local-mode-only and returns a
 * signed-out empty list when no cloud key is connected, so the list call
 * also degrades cleanly if the flags race the backend.
 */
import { useCallback, useState } from 'react'
import { Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { useDomainHttp } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'
import { api } from '../../lib/api'

export interface CloudProjectListItem {
  id: string
  name?: string
  cloudLinked?: boolean
  updatedAt?: string | null
  thumbnailUrl?: string | null
}

export interface UseOpenCloudProjectOptions {
  /**
   * Called with the linked Project once the user picks one and the API
   * has created/flagged it. Optional: when absent, the hook navigates to
   * `/(app)/projects/[id]` itself. `name` is guaranteed non-empty.
   */
  onSuccess?: (project: { id: string; name: string }) => void
}

export interface UseOpenCloudProjectResult {
  /**
   * Whether the cloud picker is reachable in the current runtime: the
   * desktop/local build with a connected cloud API key. Callers should
   * hide their "Open from Cloud" affordance when this is false.
   */
  isAvailable: boolean
  /** Fetch the cloud project list (signed-out empty shape on failure). */
  listProjects: () => Promise<{ signedIn: boolean; projects: CloudProjectListItem[] }>
  /**
   * Link + open a cloud project, then route into it (or call `onSuccess`).
   * Surfaces failures via Alert. Resolves to the opened project id, or
   * null on cancel/error.
   */
  openProject: (cloudProjectId: string, name?: string) => Promise<string | null>
  /** True while a list fetch or open is in flight. */
  isBusy: boolean
}

export function useOpenCloudProject({
  onSuccess,
}: UseOpenCloudProjectOptions = {}): UseOpenCloudProjectResult {
  const router = useRouter()
  const http = useDomainHttp()
  const { localMode, shogoKeyConnected } = usePlatformConfig()
  const [isBusy, setIsBusy] = useState(false)

  const isAvailable = !!localMode && !!shogoKeyConnected

  const listProjects = useCallback(async () => {
    setIsBusy(true)
    try {
      const res = await api.listCloudProjects(http)
      return { signedIn: res.signedIn, projects: res.projects }
    } finally {
      setIsBusy(false)
    }
  }, [http])

  const openProject = useCallback(
    async (cloudProjectId: string, name?: string): Promise<string | null> => {
      if (!cloudProjectId) return null
      setIsBusy(true)
      try {
        const res = await api.openCloudProject(http, cloudProjectId, name)
        const project = res?.project
        if (!project?.id) {
          Alert.alert('Could not open project', 'The cloud project could not be linked.')
          return null
        }
        const resolved = { id: project.id, name: project.name?.trim() || name?.trim() || 'Cloud project' }
        if (onSuccess) onSuccess(resolved)
        else router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: resolved.id } })
        return resolved.id
      } catch (err: any) {
        console.error('[useOpenCloudProject] open failed:', err)
        Alert.alert('Could not open project', err?.message ?? 'Unknown error')
        return null
      } finally {
        setIsBusy(false)
      }
    },
    [http, onSuccess, router],
  )

  return { isAvailable, listProjects, openProject, isBusy }
}
