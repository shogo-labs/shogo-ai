// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { contextBridge, ipcRenderer } from 'electron'
import { AudioCaptureManager, type PcmChunkMessage } from './audio/audio-capture-manager'

const portArg = process.argv.find((a) => a.startsWith('--api-port='))
const apiPort = portArg ? portArg.split('=')[1] : '39100'

// --- Recording capture pipeline (runs here, in the renderer) ----------------

interface ActiveSession {
  id: string
  audioPath: string
  manager: AudioCaptureManager
}

let activeSession: ActiveSession | null = null

function sendPcmChunk(sessionId: string, source: 'mic' | 'system', chunk: PcmChunkMessage): void {
  // Electron's `ipcRenderer.postMessage` only accepts MessagePort objects in
  // the transfer list — unlike the web MessagePort API, ArrayBuffers are NOT
  // transferable across its IPC boundary (the structured-clone copy is done
  // by the IPC layer regardless). That's fine: 100 ms of 48 kHz mono Int16
  // is ~9.6 KB per message, well below any meaningful overhead.
  ipcRenderer.postMessage('recording:pcm', {
    sessionId,
    source,
    sampleRate: chunk.sampleRate,
    channels: chunk.channels,
    bitsPerSample: chunk.bitsPerSample,
    frames: chunk.frames,
    buffer: chunk.buffer,
  })
}

async function stopActive(): Promise<void> {
  if (!activeSession) return
  try {
    await activeSession.manager.stop()
  } catch (err) {
    console.warn('[ShogoPreload] capture stop error:', err)
  }
  activeSession = null
}

async function startRecording(): Promise<{ ok: boolean; id?: string; audioPath?: string; error?: string }> {
  if (activeSession) {
    return { ok: false, error: 'already recording' }
  }

  const session = (await ipcRenderer.invoke('recording:start-session')) as
    | { ok: true; id: string; audioPath: string; captureSystemAudio: boolean; platform: NodeJS.Platform }
    | { ok: false; error: string }

  if (!session.ok) {
    return { ok: false, error: session.error }
  }

  const manager = new AudioCaptureManager({
    onPcm: (source, chunk) => sendPcmChunk(session.id, source, chunk),
    onError: (source, err) => {
      ipcRenderer.send('recording:source-error', {
        sessionId: session.id,
        source,
        message: err.message,
      })
    },
    onInfo: (message, data) => {
      ipcRenderer.send('recording:source-info', { sessionId: session.id, message, data })
    },
  })

  try {
    const result = await manager.start({
      sessionId: session.id,
      captureSystemAudio: session.captureSystemAudio,
      platform: session.platform,
    })
    ipcRenderer.send('recording:capture-ready', {
      sessionId: session.id,
      mic: result.mic,
      system: result.system,
    })
    if (!result.mic) {
      await manager.stop()
      await ipcRenderer.invoke('recording:abort-session', { sessionId: session.id })
      return { ok: false, error: 'microphone capture failed (permission denied?)' }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await ipcRenderer.invoke('recording:abort-session', { sessionId: session.id })
    return { ok: false, error: message }
  }

  activeSession = { id: session.id, audioPath: session.audioPath, manager }
  return { ok: true, id: session.id, audioPath: session.audioPath }
}

async function stopRecording(): Promise<{ ok: boolean; id?: string; audioPath?: string; duration?: number; error?: string }> {
  const session = activeSession
  await stopActive()
  const stopped = (await ipcRenderer.invoke('recording:stop-session')) as
    | { ok: true; id: string; audioPath: string; duration: number }
    | { ok: false; error: string }
  if (!stopped.ok) return { ok: false, error: stopped.error }
  return {
    ok: true,
    id: session?.id ?? stopped.id,
    audioPath: stopped.audioPath,
    duration: stopped.duration,
  }
}

// Abort any in-flight capture if the window is torn down abruptly.
window.addEventListener('beforeunload', () => { void stopActive() })

// --- Exposed surface -------------------------------------------------------

contextBridge.exposeInMainWorld('shogoDesktop', {
  platform: process.platform,
  isDesktop: true,
  apiUrl: `http://localhost:${apiPort}`,
  getAppMode: () => ipcRenderer.invoke('get-app-mode'),
  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  setAppMode: (mode: 'local' | 'cloud') => ipcRenderer.invoke('set-app-mode', mode),

  // Open the native folder picker for external/IDE-style projects.
  // Returns `{ ok: true, paths: string[] }` on selection or
  // `{ ok: false, error?: string }` on cancel/error.
  pickFolders: (opts?: { multi?: boolean; defaultPath?: string }): Promise<
    { ok: true; paths: string[] } | { ok: false; error?: string }
  > => ipcRenderer.invoke('pick-folders', opts ?? {}),
  getVMImageStatus: () => ipcRenderer.invoke('get-vm-image-status'),
  downloadVMImages: () => ipcRenderer.invoke('download-vm-images'),
  skipVMDownload: () => ipcRenderer.invoke('skip-vm-download'),
  getVMStatus: () => ipcRenderer.invoke('get-vm-status'),
  setVMConfig: (config: { enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number; mountWorkspace?: boolean }) =>
    ipcRenderer.invoke('set-vm-config', config),
  onVMImageNeeded: (callback: (data: { downloadUrl: string; imageDir: string }) => void) => {
    ipcRenderer.on('vm-image-needed', (_event, data) => callback(data))
  },
  onVMImageDownloadProgress: (callback: (progress: { bytesDownloaded: number; totalBytes: number; percent: number; stage: string }) => void) => {
    ipcRenderer.on('vm-image-download-progress', (_event, progress) => callback(progress))
  },
  checkVMImageUpdate: () => ipcRenderer.invoke('check-vm-image-update'),
  onVMImageUpdateAvailable: (callback: (data: { currentVersion: string | null; latestVersion: string }) => void) => {
    ipcRenderer.on('vm-image-update-available', (_event, data) => callback(data))
  },
  removeVMImageUpdateListener: () => {
    ipcRenderer.removeAllListeners('vm-image-update-available')
  },
  recycleVMPool: () => ipcRenderer.invoke('recycle-vm-pool'),

  // Meeting recording — renderer owns the Web Audio pipeline, main owns the
  // file I/O + (on macOS) the shogo-sysaudio child process.
  startRecording: () => startRecording(),
  stopRecording: () => stopRecording(),
  getRecordingStatus: () => ipcRenderer.invoke('get-recording-status'),
  getMeetingConfig: () => ipcRenderer.invoke('get-meeting-config'),
  setMeetingConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('set-meeting-config', config),
  onRecordingStarted: (callback: (data: { id: string; path: string }) => void) => {
    ipcRenderer.on('recording-started', (_event, data) => callback(data))
  },
  onRecordingDuration: (callback: (data: { id: string; duration: number }) => void) => {
    ipcRenderer.on('recording-duration', (_event, data) => callback(data))
  },
  onRecordingStopped: (callback: (data: { id: string; audioPath: string; duration: number }) => void) => {
    ipcRenderer.on('recording-stopped', (_event, data) => callback(data))
  },
  onRecordingResumed: (callback: (data: { id: string }) => void) => {
    ipcRenderer.on('recording-resumed', (_event, data) => callback(data))
  },
  onUpcomingMeeting: (callback: (data: { title: string; start: number; minutesUntilStart: number }) => void) => {
    ipcRenderer.on('upcoming-meeting', (_event, data) => callback(data))
  },
  onMeetingDetected: (callback: (data: { source: string; app?: string; title?: string }) => void) => {
    ipcRenderer.on('meeting-detected', (_event, data) => callback(data))
  },
  removeRecordingListeners: () => {
    ipcRenderer.removeAllListeners('recording-started')
    ipcRenderer.removeAllListeners('recording-duration')
    ipcRenderer.removeAllListeners('recording-stopped')
    ipcRenderer.removeAllListeners('recording-resumed')
    ipcRenderer.removeAllListeners('upcoming-meeting')
    ipcRenderer.removeAllListeners('meeting-detected')
  },
  onNavigate: (callback: (path: string) => void) => {
    ipcRenderer.on('navigate', (_event, path) => callback(path))
  },
  removeNavigateListener: () => {
    ipcRenderer.removeAllListeners('navigate')
  },

  // App updates — downloads are user-gated. The main process probes the
  // feed and broadcasts `status: 'available'` with a version; the renderer
  // shows a banner and only calls `downloadUpdate()` after the user
  // explicitly opts in.
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  dismissUpdate: () => ipcRenderer.invoke('dismiss-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (
    callback: (data: { status: string; releaseName: string | null; availableVersion: string | null }) => void,
  ) => {
    ipcRenderer.on('desktop-update-status', (_event, data) => callback(data))
  },
  removeUpdateListener: () => {
    ipcRenderer.removeAllListeners('desktop-update-status')
  },
  showRemoteActionNotification: (title: string, body: string) =>
    ipcRenderer.invoke('show-remote-action-notification', title, body),
  showChatNotification: (args: {
    title: string
    body: string
    sessionId: string
    projectId: string
  }) => ipcRenderer.invoke('show-chat-notification', args),
  onNotificationClicked: (
    callback: (data: { sessionId: string; projectId: string }) => void,
  ) => {
    ipcRenderer.on('notification-clicked', (_event, data) => callback(data))
  },
  removeNotificationClickedListener: () => {
    ipcRenderer.removeAllListeners('notification-clicked')
  },
  isWindowFocused: () => ipcRenderer.invoke('get-window-focused'),

  // Cloud login (replaces the old paste-API-key flow)
  getDeviceInfo: (): Promise<{ id: string; name: string; platform: string; appVersion: string }> =>
    ipcRenderer.invoke('get-device-info'),
  startCloudLogin: (opts?: { workspaceId?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('start-cloud-login', opts),
  cancelCloudLogin: (): Promise<{ ok: boolean; cancelled?: boolean }> =>
    ipcRenderer.invoke('cancel-cloud-login'),
  signOutCloud: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('sign-out-cloud'),
  onCloudLoginResult: (
    callback: (result: { ok: boolean; error?: string; email?: string; workspace?: string }) => void,
  ) => {
    ipcRenderer.on('cloud-login-result', (_event, result) => callback(result))
  },
  removeCloudLoginListener: () => {
    ipcRenderer.removeAllListeners('cloud-login-result')
  },
  onCloudConnectionStatus: (
    callback: (status: { connected: boolean; cloudKeyRejected: boolean; error?: string }) => void,
  ) => {
    ipcRenderer.on('cloud-connection-status', (_event, status) => callback(status))
  },
  removeCloudConnectionStatusListener: () => {
    ipcRenderer.removeAllListeners('cloud-connection-status')
  },

  // Local filesystem fast-path for the IDE Monaco file tree + file reads.
  // Bypasses the loopback HTTP round-trip to per-project agent-runtimes so
  // the tree renders the moment the user opens a project, before the
  // runtime has finished spawning. Backed by `fs-ipc.ts` in main, which
  // validates every path against `getWorkspacesDir()` — calls for external
  // (folder-bound) projects return `ok: false` and the renderer falls back
  // to the HTTP `SdkFs` path. Writes / SSE subscriptions are intentionally
  // NOT included here: those still flow through agent-runtime so its file
  // watcher + RAG indexer stay authoritative for mutations.
  fs: {
    resolveWorkspace: (projectId: string): Promise<{ ok: boolean; root?: string; reason?: string }> =>
      ipcRenderer.invoke('fs:resolveWorkspace', projectId),
    listTree: (root: string, path?: string): Promise<{ ok: boolean; tree?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('fs:listTree', root, path),
    readFile: (root: string, relPath: string): Promise<{ ok: boolean; content?: string; size?: number; mtime?: number; error?: string }> =>
      ipcRenderer.invoke('fs:readFile', root, relPath),
  },

  // --- Git (G1: read-only awareness) ------------------------------------
  // Backed by `apps/desktop/src/git/` in main. Shells out to the user's
  // installed `git` CLI in the workspace root and streams porcelain v2
  // status snapshots to the renderer. Every call validates the workspace
  // path lives under $HOME on the main side; this surface is harmless on
  // its own.
  git: {
    probe: (): Promise<{ ok: boolean; available: boolean; version: string | null; supportsPorcelainV2: boolean; error?: string }> =>
      ipcRenderer.invoke('git:probe'),
    subscribe: (workspaceRoot: string, onSnapshot: (snap: unknown) => void): Promise<{ ok: boolean; subId?: string; channel?: string; reason?: string }> => {
      const result = ipcRenderer.invoke('git:subscribe', { workspaceRoot })
      void result.then((r: any) => {
        if (r?.ok && r.channel) {
          ipcRenderer.on(r.channel, (_event, snap) => onSnapshot(snap))
        }
      })
      return result
    },
    unsubscribe: (subId: string, channel: string): Promise<{ ok: boolean; reason?: string }> => {
      ipcRenderer.removeAllListeners(channel)
      return ipcRenderer.invoke('git:unsubscribe', { subId })
    },
    refresh: (workspaceRoot: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('git:refresh', { workspaceRoot }),
    current: (workspaceRoot: string): Promise<{ ok: boolean; snapshot?: unknown; reason?: string }> =>
      ipcRenderer.invoke('git:current', { workspaceRoot }),
    // G2 — write side + project-root resolver. setProjectRoot is called by
    // useOpenLocalFolder right after POST /from-folders so external folder
    // projects can be resolved without an API round-trip on every git call.
    setProjectRoot: (projectId: string, root: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('git:setProjectRoot', { projectId, root }),
    unsetProjectRoot: (projectId: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('git:unsetProjectRoot', { projectId }),
    resolveProjectRoot: (projectId: string): Promise<{ ok: boolean; root?: string; reason?: string }> =>
      ipcRenderer.invoke('git:resolveProjectRoot', { projectId }),
    stage: (workspaceRoot: string, paths: string[]): Promise<{ ok: boolean; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:stage', { workspaceRoot, paths }),
    unstage: (workspaceRoot: string, paths: string[]): Promise<{ ok: boolean; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:unstage', { workspaceRoot, paths }),
    discard: (workspaceRoot: string, paths: string[]): Promise<{ ok: boolean; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:discard', { workspaceRoot, paths }),
    commit: (workspaceRoot: string, message: string, opts?: { amend?: boolean; signoff?: boolean }): Promise<{ ok: boolean; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:commit', { workspaceRoot, message, amend: opts?.amend, signoff: opts?.signoff }),
    fileContent: (workspaceRoot: string, path: string, ref: string): Promise<{ ok: boolean; content?: string; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:fileContent', { workspaceRoot, path, ref }),
    // G3 — branches.
    branches: {
      list: (workspaceRoot: string): Promise<{ ok: boolean; branches?: unknown[]; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:branches.list', { workspaceRoot }),
      checkout: (workspaceRoot: string, name: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:branches.checkout', { workspaceRoot, name }),
      create: (workspaceRoot: string, name: string, base?: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:branches.create', { workspaceRoot, name, base }),
      delete: (workspaceRoot: string, name: string, force?: boolean): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:branches.delete', { workspaceRoot, name, force }),
      rename: (workspaceRoot: string, oldName: string, newName: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:branches.rename', { workspaceRoot, oldName, newName }),
      publish: (workspaceRoot: string, branch: string, remote?: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:branches.publish', { workspaceRoot, branch, remote }),
    },
    // G3 — remotes (long-running; the renderer is responsible for the
    // spinner). Credential prompts are gated by GIT_TERMINAL_PROMPT=0 in
    // the spawn wrapper so push/pull either succeeds via the user's
    // credential helper or fails fast.
    remotes: {
      list: (workspaceRoot: string): Promise<{ ok: boolean; remotes?: string[]; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:remotes.list', { workspaceRoot }),
      fetch: (workspaceRoot: string, opts?: { remote?: string; prune?: boolean; all?: boolean }): Promise<{ ok: boolean; output?: string; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:remotes.fetch', { workspaceRoot, ...(opts ?? {}) }),
      pull: (workspaceRoot: string, opts?: { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }): Promise<{ ok: boolean; output?: string; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:remotes.pull', { workspaceRoot, ...(opts ?? {}) }),
      push: (workspaceRoot: string, opts?: { remote?: string; branch?: string; force?: boolean; forceWithLease?: boolean; tags?: boolean; setUpstream?: boolean }): Promise<{ ok: boolean; output?: string; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:remotes.push', { workspaceRoot, ...(opts ?? {}) }),
      sync: (workspaceRoot: string, opts?: { remote?: string; branch?: string; rebase?: boolean }): Promise<{ ok: boolean; output?: string; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:remotes.sync', { workspaceRoot, ...(opts ?? {}) }),
    },
    // G3 — stash.
    stash: {
      list: (workspaceRoot: string): Promise<{ ok: boolean; entries?: unknown[]; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:stash.list', { workspaceRoot }),
      push: (workspaceRoot: string, opts?: { message?: string; keepIndex?: boolean; includeUntracked?: boolean }): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:stash.push', { workspaceRoot, ...(opts ?? {}) }),
      apply: (workspaceRoot: string, ref: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:stash.apply', { workspaceRoot, ref }),
      pop: (workspaceRoot: string, ref: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:stash.pop', { workspaceRoot, ref }),
      drop: (workspaceRoot: string, ref: string): Promise<{ ok: boolean; reason?: string; error?: string }> =>
        ipcRenderer.invoke('git:stash.drop', { workspaceRoot, ref }),
    },
    // G4 — per-file diff markers (for gutter decorations) + blame (for
    // inline blame at end-of-cursor-line).
    diffMarkers: (workspaceRoot: string, path: string, base?: string): Promise<{ ok: boolean; markers?: unknown[]; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:diffMarkers', { workspaceRoot, path, base }),
    blame: (workspaceRoot: string, path: string): Promise<{ ok: boolean; lines?: unknown[]; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:blame', { workspaceRoot, path }),
    // G4.5 — 3-way merge stages + per-hunk revert.
    mergeStages: (workspaceRoot: string, path: string): Promise<{ ok: boolean; stages?: { base: string | null; ours: string | null; theirs: string | null; working: string }; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:mergeStages', { workspaceRoot, path }),
    revertHunk: (workspaceRoot: string, path: string, workingStart: number, workingEnd: number, headStart: number | null, headEnd: number | null): Promise<{ ok: boolean; reason?: string; error?: string }> =>
      ipcRenderer.invoke('git:revertHunk', { workspaceRoot, path, workingStart, workingEnd, headStart, headEnd }),
    // G3.5 — streaming fetch/pull/push. `onProgress` is invoked per
    // stderr progress line; the returned promise resolves when the op
    // completes (success or failure).
    fetchStreaming: (workspaceRoot: string, opts: { remote?: string; prune?: boolean; all?: boolean }, onProgress: (p: { phase: string; percent: number | null; raw: string }) => void): Promise<{ ok: boolean; jobId?: string; output?: string; reason?: string; error?: string }> => {
      const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
      const channel = `git:progress:${jobId}`;
      const listener = (_e: unknown, p: { phase: string; percent: number | null; raw: string }) => onProgress(p);
      ipcRenderer.on(channel, listener);
      return ipcRenderer.invoke('git:remotes.fetchStreaming', { workspaceRoot, ...opts, jobId }).finally(() => ipcRenderer.removeListener(channel, listener));
    },
    pullStreaming: (workspaceRoot: string, opts: { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }, onProgress: (p: { phase: string; percent: number | null; raw: string }) => void): Promise<{ ok: boolean; jobId?: string; output?: string; reason?: string; error?: string }> => {
      const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
      const channel = `git:progress:${jobId}`;
      const listener = (_e: unknown, p: { phase: string; percent: number | null; raw: string }) => onProgress(p);
      ipcRenderer.on(channel, listener);
      return ipcRenderer.invoke('git:remotes.pullStreaming', { workspaceRoot, ...opts, jobId }).finally(() => ipcRenderer.removeListener(channel, listener));
    },
    pushStreaming: (workspaceRoot: string, opts: { remote?: string; branch?: string; forceWithLease?: boolean; force?: boolean; tags?: boolean; setUpstream?: boolean }, onProgress: (p: { phase: string; percent: number | null; raw: string }) => void): Promise<{ ok: boolean; jobId?: string; output?: string; reason?: string; error?: string }> => {
      const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
      const channel = `git:progress:${jobId}`;
      const listener = (_e: unknown, p: { phase: string; percent: number | null; raw: string }) => onProgress(p);
      ipcRenderer.on(channel, listener);
      return ipcRenderer.invoke('git:remotes.pushStreaming', { workspaceRoot, ...opts, jobId }).finally(() => ipcRenderer.removeListener(channel, listener));
    },
  },

  // --- External preview (Electron WebContentsView) ---------------------
  // Used by ExternalPreviewWebView in apps/mobile to embed a real
  // Chromium view of the user's own dev server. Lives outside the React
  // tree as an absolutely-positioned overlay; the renderer publishes
  // bounds and main keeps the view aligned. See preview-views.ts.
  preview: {
    open: (
      projectId: string,
      url: string,
      opts?: { allowNonLocal?: boolean },
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('preview:open', {
        projectId,
        url,
        allowNonLocal: !!opts?.allowNonLocal,
      }),
    close: (projectId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('preview:close', { projectId }),
    setBounds: (
      projectId: string,
      bounds: { x: number; y: number; width: number; height: number },
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('preview:set-bounds', { projectId, bounds }),
    setVisible: (projectId: string, visible: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('preview:set-visible', { projectId, visible }),
    reload: (projectId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('preview:reload', { projectId }),
    goBack: (projectId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('preview:go-back', { projectId }),
    goForward: (projectId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('preview:go-forward', { projectId }),
    getState: (projectId: string): Promise<
      | { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }
      | null
    > => ipcRenderer.invoke('preview:get-state', { projectId }),
    /**
     * Subscribe to preview lifecycle events (url-changed, load-failed,
     * title-changed, loading-changed). Returns an unsubscribe handle.
     * Events for all projects share a single channel; the callback is
     * expected to filter by `projectId`.
     */
    onEvent: (
      callback: (ev: {
        projectId: string
        event: 'url-changed' | 'load-failed' | 'title-changed' | 'loading-changed'
        url?: string
        title?: string
        errorCode?: number
        errorDescription?: string
        loading?: boolean
      }) => void,
    ): (() => void) => {
      const listener = (_event: unknown, ev: any) => callback(ev)
      ipcRenderer.on('preview:event', listener)
      return () => {
        ipcRenderer.removeListener('preview:event', listener)
      }
    },
  },

  // Bug report / log sharing
  captureScreenshot: (): Promise<{ ok: boolean; base64?: string; error?: string }> =>
    ipcRenderer.invoke('capture-screenshot'),
  exportBugReport: (payload: { description: string; attachments?: { name: string; dataUrl: string }[] }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('export-bug-report', payload),
  submitBugReport: (payload: { description: string; attachments?: { name: string; dataUrl: string }[] }): Promise<{ ok: boolean; error?: string; discord?: { ok: boolean }; github?: { ok: boolean; issueUrl?: string } }> =>
    ipcRenderer.invoke('submit-bug-report', payload),
  getBugReportConfig: (): Promise<{ hasDiscord: boolean; hasGitHub: boolean; maxLogLines: number }> =>
    ipcRenderer.invoke('get-bug-report-config'),
  setBugReportConfig: (config: { discordWebhookUrl?: string; githubRepo?: string; githubToken?: string; maxLogLines?: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('set-bug-report-config', config),
  getSystemInfo: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('get-system-info'),
})

// ─── Desktop terminal bridge ─────────────────────────────────────────────────
// Exposes window.shogoDesktopTerminal. Lives in its own module so the
// terminal-related contextBridge surface and port-handoff plumbing stay
// out of the recording / IDE / preview wiring above. See
// `preload-terminal.ts` for the full bridge implementation.
import { exposeShogoDesktopTerminalBridge } from './preload-terminal'
exposeShogoDesktopTerminalBridge()

// Exposes window.shogoDesktopPorts — Phase 12 Ports tab bridge. Lives in its
// own module so the contextBridge surface stays separable per feature.
import { exposeShogoDesktopPortsBridge } from './preload-ports'
exposeShogoDesktopPortsBridge()

if (process.env.SHOGO_E2E === '1' || process.env.PLAYWRIGHT_E2E === '1') {
  contextBridge.exposeInMainWorld('shogoTesting', {
    openTerminal() {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '`',
        code: 'Backquote',
        metaKey: process.platform === 'darwin',
        ctrlKey: process.platform !== 'darwin',
        bubbles: true,
      }))
    },
    sendKeys(text: string) {
      document.activeElement?.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
      }))
    },
    getActiveSurface() {
      return document.querySelector('[data-shogo-terminal-surface="true"]') !== null
    },
  })
}
