// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useOpenLocalFolder — shared logic for the "Open Folder…" project
 * creation flow.
 *
 * Walks the user through:
 *   1. Picking a folder using the OS-native file selector
 *      (Electron's `dialog.showOpenDialog` via the
 *      `window.shogoDesktop.pickFolders` IPC). The browser File System
 *      Access API can't be used here because it doesn't expose absolute
 *      paths to JS — and we need absolute paths so the API can validate
 *      them (under `$HOME`, not a system root, realpath'd) before
 *      linking the folder to a project. So this flow is Electron-only.
 *   2. `POST /from-folders`, including the git-root walk-up
 *      confirmation when the picked path is inside a `.git` repo.
 *   3. Returning the resulting Project to the caller via `onSuccess`,
 *      or navigating to the new project page when no callback is given.
 *
 * Why a hook (and not a component): two surfaces need this flow — the
 * home composer's "Source" menu and the projects-list "+ New" menu —
 * and one source of truth for the picker + git-root prompt is cheaper
 * to maintain than two copies.
 */
import { useCallback, useEffect, useState } from 'react'
import { Platform, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'

interface DesktopBridge {
  pickFolders?: (opts?: { multi?: boolean; defaultPath?: string }) => Promise<
    { ok: true; paths: string[] } | { ok: false; error?: string }
  >
}

/**
 * Returns the Electron-injected `window.shogoDesktop` bridge if the
 * preload script has exposed it, otherwise undefined. Encapsulated so
 * callers don't have to repeat the `typeof window` / Platform dance.
 */
function getDesktopBridge(): DesktopBridge | undefined {
  if (Platform.OS !== 'web') return undefined
  if (typeof window === 'undefined') return undefined
  return (window as any).shogoDesktop as DesktopBridge | undefined
}

export interface UseOpenLocalFolderOptions {
  workspaceId: string | undefined
  /**
   * Called with the newly-created Project once the user has picked a
   * folder and the API has linked it. Optional: when absent, the hook
   * navigates to `/(app)/projects/[id]` itself. The hook guarantees a
   * non-empty `name` (falls back to "Untitled" if the API omits one).
   */
  onSuccess?: (project: { id: string; name: string }) => void
}

export interface UseOpenLocalFolderResult {
  /**
   * Trigger the OS-native picker → API → route sequence. Resolves once
   * the user has either committed to a folder + we've navigated, or
   * cancelled, or hit an error (errors are surfaced via Alert).
   */
  openFolder: () => Promise<void>
  /** True while any step of the flow is in flight. */
  isPicking: boolean
  /**
   * Whether the OS-native picker is reachable in the current runtime
   * (true in Electron Desktop, false in `bun dev:all` browser tabs and
   * in native mobile builds). Callers should hide their "Open folder"
   * affordance when this is false — the picker can't be invoked
   * outside Electron without giving up absolute paths, which the
   * backend's path-validation gauntlet requires.
   */
  isAvailable: boolean
}

export function useOpenLocalFolder({
  workspaceId,
  onSuccess,
}: UseOpenLocalFolderOptions): UseOpenLocalFolderResult {
  const router = useRouter()
  const http = useDomainHttp()
  const [isPicking, setIsPicking] = useState(false)
  const [isAvailable, setIsAvailable] = useState<boolean>(() =>
    Boolean(getDesktopBridge()?.pickFolders),
  )

  // The Electron preload runs before the renderer's first React render,
  // so in practice `window.shogoDesktop` is already present at mount —
  // but a defensive re-check on mount handles SSR hydration and any
  // late-loaded preload variants without forcing every caller to think
  // about it.
  useEffect(() => {
    setIsAvailable(Boolean(getDesktopBridge()?.pickFolders))
  }, [])

  const openFolder = useCallback(async () => {
    if (isPicking) return
    const bridge = getDesktopBridge()
    if (!bridge?.pickFolders) {
      // Native picker isn't available. We deliberately don't fall back
      // to an in-app picker here — the option should have been hidden
      // by the caller via `isAvailable`. This Alert exists only as a
      // last-resort guard so the user gets a clear message instead of
      // a silent no-op when something unexpected happens.
      Alert.alert(
        'Open folder unavailable',
        'Folder picking requires the Shogo desktop app. Run the Desktop build to link a local folder.',
      )
      return
    }

    setIsPicking(true)
    try {
      const picked = await bridge.pickFolders({ multi: false })
      if (!picked?.ok || !Array.isArray(picked.paths) || picked.paths.length === 0) {
        return
      }

      let res = (await api.createLocalFolderProject(http, {
        paths: picked.paths,
        workspaceId,
      })) as any

      if (res?.needsGitRootChoice) {
        // Pre-existing UX: confirm the git-root walk-up via an Alert.
        // Matches CLI tools like aider that ask the same yes/no.
        const choice = await new Promise<'parent' | 'subfolder' | null>((resolve) => {
          Alert.alert(
            'Use parent repo?',
            `The folder you picked is inside a git repo:\n\n${res.gitRoot}\n\n` +
              `Opening the repo root gives the agent context across the whole project. ` +
              `Or stick with the subfolder you picked: ${res.picked}.`,
            [
              { text: 'Use repo root', onPress: () => resolve('parent') },
              { text: 'Keep subfolder', onPress: () => resolve('subfolder') },
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
            ],
            { cancelable: true, onDismiss: () => resolve(null) },
          )
        })
        if (!choice) return
        res = (await api.createLocalFolderProject(http, {
          paths: picked.paths,
          workspaceId,
          acceptedGitRoot: choice === 'parent',
        })) as any
      }

      const project = res?.project as { id?: string; name?: string } | undefined
      if (project?.id) {
        if (onSuccess) onSuccess({ id: project.id, name: project.name ?? 'Untitled' })
        else router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: project.id } })
      } else if (res?.error || res?.message) {
        Alert.alert('Could not open folder', String(res.message ?? res.error))
      }
    } catch (err: any) {
      console.error('[useOpenLocalFolder] failed:', err)
      Alert.alert('Could not open folder', err?.message ?? 'Unknown error')
    } finally {
      setIsPicking(false)
    }
  }, [http, isPicking, onSuccess, router, workspaceId])

  return { openFolder, isPicking, isAvailable }
}
