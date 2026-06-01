// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ExternalPreviewWebView — embedded browser for external (folder-linked)
 * projects.
 *
 * For projects with `workingMode === 'external'`, this component renders
 * an Electron `WebContentsView` overlay that loads any URL the user
 * supplies — typically `http://localhost:PORT` for their own running dev
 * server. The webview is owned by the Electron main process (see
 * `apps/desktop/src/preview-views.ts`); this React component is a thin
 * controller that:
 *
 *   - publishes its on-screen bounds via `setBounds` so main keeps the
 *     overlay aligned with the React pane,
 *   - drives lifecycle (`open` on mount with a URL, `setVisible(false)`
 *     when a sibling tab takes over, `close` on unmount),
 *   - renders an address bar (URL input, back/forward, reload, open
 *     externally), and
 *   - on non-desktop or when the preload bridge is missing, falls back
 *     to a "Preview is desktop-only" empty state.
 *
 * The actual webview surface is transparent from the React side — the
 * Electron view paints over whatever this component renders in its
 * `bounds` rectangle. We keep a placeholder `View` underneath so React
 * Native layout still allocates the space.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Platform,
  Pressable,
  TextInput,
  View,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { Text } from 'react-native'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Monitor,
  RefreshCw,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface PreviewBridge {
  open: (
    projectId: string,
    url: string,
    opts?: { allowNonLocal?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>
  close: (projectId: string) => Promise<unknown>
  setBounds: (
    projectId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => Promise<unknown>
  setVisible: (projectId: string, visible: boolean) => Promise<unknown>
  reload: (projectId: string) => Promise<unknown>
  goBack: (projectId: string) => Promise<unknown>
  goForward: (projectId: string) => Promise<unknown>
  getState: (projectId: string) => Promise<
    | { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }
    | null
  >
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
  ) => () => void
}

function getPreviewBridge(): PreviewBridge | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const w = window as unknown as { shogoDesktop?: { preview?: PreviewBridge } }
  return w.shogoDesktop?.preview ?? null
}

function getDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1
  return (window as any).devicePixelRatio || 1
}

export interface ExternalPreviewWebViewProps {
  projectId: string
  /** The dev-server URL to load. When null, shows the "no URL" empty state. */
  url: string | null
  /**
   * Whether this view is currently the active preview tab. When false the
   * overlay is hidden (bounds zeroed) but kept alive so navigation state
   * survives a tab switch.
   */
  visible: boolean
  /** Called when the user submits a new URL in the address bar. */
  onUrlSubmit?: (url: string) => void
  /** Optional helper text under the empty state, e.g. "Run npm run dev". */
  emptyHint?: string
  /** Most-recent URL detected from the agent terminal, shown as a chip. */
  detectedUrl?: string | null
  /**
   * `true` when the project's trust level is 'trusted'. Restricted
   * projects can only load local hosts; non-local URLs require this
   * flag (and the matching server-side check). When the user submits
   * a non-local URL on a restricted project, `onTrustRequired` fires
   * so the layout can pop the workspace-trust modal.
   */
  isTrusted?: boolean
  onTrustRequired?: (url: string) => void
}

export function ExternalPreviewWebView({
  projectId,
  url,
  visible,
  onUrlSubmit,
  emptyHint,
  detectedUrl,
  isTrusted,
  onTrustRequired,
}: ExternalPreviewWebViewProps) {
  const bridge = useMemo(getPreviewBridge, [])
  const placeholderRef = useRef<View | null>(null)
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const lastSentUrlRef = useRef<string | null>(null)
  const [currentUrl, setCurrentUrl] = useState<string | null>(url)
  const [draftUrl, setDraftUrl] = useState<string>(url ?? '')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [waitingForServer, setWaitingForServer] = useState(false)

  // Keep the draft URL in sync when the parent supplies a new one.
  useEffect(() => {
    setDraftUrl(url ?? '')
    if (url) setCurrentUrl(url)
  }, [url])

  // Subscribe to lifecycle events from main. Filter by projectId so a
  // sibling project's events don't bleed in. Single subscription per
  // component instance — main fans out to all renderers.
  useEffect(() => {
    if (!bridge) return
    const unsubscribe = bridge.onEvent((ev) => {
      if (ev.projectId !== projectId) return
      if (ev.event === 'url-changed' && typeof ev.url === 'string') {
        setCurrentUrl(ev.url)
        setDraftUrl((prev) => (prev === lastSentUrlRef.current ? ev.url : prev))
        setLoadError(null)
        setWaitingForServer(false)
        void bridge.getState(projectId).then((state) => {
          if (state) {
            setCanGoBack(state.canGoBack)
            setCanGoForward(state.canGoForward)
          }
        })
      } else if (ev.event === 'loading-changed') {
        setLoading(!!ev.loading)
      } else if (ev.event === 'load-failed') {
        // ERR_CONNECTION_REFUSED / ERR_FAILED — dev server not up yet.
        setLoading(false)
        setWaitingForServer(true)
        setLoadError(ev.errorDescription ?? null)
      }
    })
    return () => unsubscribe()
  }, [bridge, projectId])

  // Push bounds whenever the placeholder lays out. We multiply by DPR so
  // the WebContentsView aligns with logical pixels under HiDPI / Retina.
  const pushBounds = useCallback(() => {
    if (!bridge) return
    const node = placeholderRef.current as unknown as { measureInWindow?: Function } | null
    if (!node?.measureInWindow) return
    node.measureInWindow((x: number, y: number, width: number, height: number) => {
      const next = { x, y, width, height }
      const prev = lastBoundsRef.current
      if (
        prev &&
        Math.abs(prev.x - next.x) < 0.5 &&
        Math.abs(prev.y - next.y) < 0.5 &&
        Math.abs(prev.width - next.width) < 0.5 &&
        Math.abs(prev.height - next.height) < 0.5
      ) {
        return
      }
      lastBoundsRef.current = next
      void bridge.setBounds(projectId, next)
    })
  }, [bridge, projectId])

  // Watch resizes of the host window — Electron doesn't fire onLayout
  // for the placeholder when only the outer window changes size.
  useEffect(() => {
    if (!bridge) return
    if (typeof window === 'undefined') return
    const handler = () => pushBounds()
    window.addEventListener('resize', handler)
    // Also poll on a short interval to catch sidebar collapses / layout
    // shifts that don't fire `resize` (CSS-driven width changes inside
    // the React Native Web flexbox layout).
    const interval = setInterval(pushBounds, 250)
    return () => {
      window.removeEventListener('resize', handler)
      clearInterval(interval)
    }
  }, [bridge, pushBounds])

  // Open / navigate when URL or visibility changes.
  useEffect(() => {
    if (!bridge) return
    if (!url) {
      // No URL → tear down to free resources. Sibling components that
      // come back later will re-open with a fresh state.
      void bridge.close(projectId)
      lastSentUrlRef.current = null
      return
    }
    if (lastSentUrlRef.current !== url) {
      lastSentUrlRef.current = url
      setLoadError(null)
      setWaitingForServer(false)
      void bridge.open(projectId, url, { allowNonLocal: !!isTrusted }).then((res) => {
        if (!res?.ok) {
          // "trust-required" → main rejected because the URL is
          // non-local and we passed allowNonLocal=false. Bubble up so
          // the layout can pop the workspace-trust modal.
          if (res?.error === 'trust-required') {
            onTrustRequired?.(url)
          }
          setLoadError(res?.error ?? 'open-failed')
          return
        }
        // If the parent has hidden this preview (for example while a
        // React modal is open), re-apply that state after `open` creates
        // the native Electron view. A prior `setVisible(false)` can be a
        // no-op when the view does not exist yet.
        void bridge.setVisible(projectId, visible)
        if (visible) pushBounds()
      })
    }
  }, [bridge, projectId, url, isTrusted, onTrustRequired, visible, pushBounds])

  useEffect(() => {
    if (!bridge) return
    void bridge.setVisible(projectId, visible)
    if (visible) pushBounds()
  }, [bridge, projectId, visible, pushBounds])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (!bridge) return
      void bridge.close(projectId)
    }
  }, [bridge, projectId])

  const handleSubmit = useCallback(() => {
    const next = draftUrl.trim()
    if (!next) return
    const withProtocol = /^https?:\/\//i.test(next) ? next : `http://${next}`
    onUrlSubmit?.(withProtocol)
  }, [draftUrl, onUrlSubmit])

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) return
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(currentUrl, '_blank', 'noopener,noreferrer')
    }
  }, [currentUrl])

  // ── Desktop-only fallback ────────────────────────────────────────────
  if (!bridge) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Monitor size={36} className="text-muted-foreground mb-3" />
        <Text className="text-base font-semibold text-foreground text-center">
          Preview is desktop-only
        </Text>
        <Text className="text-sm text-muted-foreground text-center mt-1.5">
          Open this project in the Shogo desktop app to view your local dev server inside Shogo.
        </Text>
      </View>
    )
  }

  return (
    <View className="flex-1 flex-col bg-background">
      {/* Address bar */}
      <View className="flex-row items-center gap-1.5 px-2 py-1.5 border-b border-border bg-card">
        <Pressable
          accessibilityLabel="Back"
          onPress={() => bridge.goBack(projectId)}
          disabled={!canGoBack}
          className={cn(
            'rounded-md p-1.5',
            canGoBack ? 'active:bg-muted' : 'opacity-40',
          )}
        >
          <ArrowLeft size={14} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          accessibilityLabel="Forward"
          onPress={() => bridge.goForward(projectId)}
          disabled={!canGoForward}
          className={cn(
            'rounded-md p-1.5',
            canGoForward ? 'active:bg-muted' : 'opacity-40',
          )}
        >
          <ArrowRight size={14} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          accessibilityLabel="Reload"
          onPress={() => bridge.reload(projectId)}
          className="rounded-md p-1.5 active:bg-muted"
        >
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>
        <View className="flex-1 flex-row items-center gap-1.5 rounded-md bg-muted px-2 py-1">
          <Globe size={12} className="text-muted-foreground" />
          <TextInput
            value={draftUrl}
            onChangeText={setDraftUrl}
            onSubmitEditing={handleSubmit}
            placeholder="http://localhost:3000"
            placeholderTextColor="rgba(115,115,115,0.7)"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            spellCheck={false}
            className="flex-1 text-xs text-foreground"
            style={addressInputStyle}
          />
          {loading ? <ActivityIndicator size="small" /> : null}
        </View>
        {detectedUrl && detectedUrl !== currentUrl ? (
          <Pressable
            accessibilityLabel="Use detected URL"
            onPress={() => onUrlSubmit?.(detectedUrl)}
            className="rounded-md bg-emerald-500/10 px-2 py-1 active:opacity-80"
          >
            <Text className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              Use {prettyHost(detectedUrl)}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Open in system browser"
          onPress={handleOpenExternal}
          disabled={!currentUrl}
          className={cn(
            'rounded-md p-1.5',
            currentUrl ? 'active:bg-muted' : 'opacity-40',
          )}
        >
          <ExternalLink size={14} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Body — placeholder that the Electron view paints over */}
      <View className="flex-1 relative">
        <View
          ref={placeholderRef}
          collapsable={false}
          onLayout={pushBounds}
          className="absolute inset-0 bg-background"
        />
        {!url ? (
          <View className="absolute inset-0 items-center justify-center px-6">
            <Globe size={32} className="text-muted-foreground mb-3" />
            <Text className="text-sm font-semibold text-foreground text-center">
              No preview URL yet
            </Text>
            <Text className="text-xs text-muted-foreground text-center mt-1.5 max-w-[420px]">
              {emptyHint ??
                'Run your dev server (e.g. npm run dev) in the agent terminal and Shogo will detect the URL, or paste it in the address bar above.'}
            </Text>
            {detectedUrl ? (
              <Pressable
                onPress={() => onUrlSubmit?.(detectedUrl)}
                className="mt-3 rounded-md bg-primary px-3 py-1.5 active:opacity-80"
              >
                <Text className="text-xs font-medium text-primary-foreground">
                  Open {prettyHost(detectedUrl)}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : waitingForServer ? (
          <View
            className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-amber-500/10 border border-amber-300/30 px-3 py-1 flex-row items-center gap-1.5"
            pointerEvents="none"
          >
            <ActivityIndicator size="small" />
            <Text className="text-[11px] text-amber-700 dark:text-amber-300">
              Waiting for dev server… {loadError ? `(${loadError})` : null}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}

function prettyHost(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.host
  } catch {
    return rawUrl
  }
}

const addressInputStyle = StyleSheet.flatten({
  paddingVertical: 0,
  outlineWidth: 0,
} as any)
