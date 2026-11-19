// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A PowerPoint deck, rendered as real slides in a sandboxed frame (SHO-426).
 *
 * The renderer writes untrusted deck content into the DOM with `innerHTML`, so
 * it never runs on the app's origin: the iframe is `sandbox="allow-scripts"`
 * (no `allow-same-origin`, so its origin is opaque) and the page it loads
 * carries `Content-Security-Policy: sandbox` from the API, which keeps that
 * true even where the frame is loaded top-level. The deck's bytes are fetched
 * here, with the app's own credentials, and posted in — the frame never
 * fetches anything and the file never appears in a URL.
 *
 * Web only. On iOS and Android `FileContentView` mounts `NativeSlides` on the
 * same page.
 */

import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react-native'
import { API_URL } from '../../../../lib/api-url'
import {
  SLIDES_RENDER_TIMEOUT_MS,
  fetchSlidesBytes,
  parseSlidesViewerMessage,
  slidesLoadMessage,
  slidesPreviewErrorText,
  slidesViewerUrl,
  type SlidesTheme,
} from './slides-viewer-protocol'

export { isSlidesPath } from './slides-viewer-protocol'

export function SlidesPreview({
  url,
  name,
  onError,
}: {
  url: string
  name: string
  path: string
  /** The host's chance to show extracted text instead of a dead frame. */
  onError?: (message: string) => void
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; slideCount: number }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setBytes(null)
    fetchSlidesBytes(url)
      .then((next) => {
        if (!cancelled) setBytes(next)
      })
      .catch((error) => {
        if (cancelled) return
        const message = slidesPreviewErrorText(error, name)
        setState({ status: 'error', message })
        onError?.(message)
      })
    return () => {
      cancelled = true
    }
  }, [url, name, onError])

  // Only our own frame may talk to us: any other window on the page (a preview
  // the user is running, an extension) is ignored.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const message = parseSlidesViewerMessage(event.data)
      if (!message) return
      if (message.type === 'rendered') setState({ status: 'ready', slideCount: message.slideCount })
      else if (message.type === 'error') {
        setState({ status: 'error', message: message.message })
        onError?.(message.message)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onError])

  // Nothing arrives within the cap: stop waiting rather than spin forever.
  // The effect re-runs on every status change, so its cleanup clears this timer
  // the moment the frame reports `rendered` — no state read is needed in here.
  useEffect(() => {
    if (state.status !== 'loading') return
    const timer = setTimeout(() => {
      const message = `Could not render ${name} within ${SLIDES_RENDER_TIMEOUT_MS / 1000}s.`
      setState({ status: 'error', message })
      onError?.(message)
    }, SLIDES_RENDER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [state.status, name, onError])

  // The bytes only go in once the page says it is listening.
  useEffect(() => {
    if (!bytes) return
    const frame = frameRef.current
    if (!frame) return
    // The IDE and the viewers paint their own chrome, so the frame follows the
    // theme the host already decided instead of a prop threaded through them.
    const theme: SlidesTheme =
      rootRef.current?.closest('[data-theme]')?.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    const post = () => {
      const target = frame.contentWindow
      if (!target) return
      const { message, transfer } = slidesLoadMessage(name, theme, bytes)
      target.postMessage(message, '*', transfer)
    }
    // Only a post made in answer to the page's own `ready` latches. The blind
    // post below must not: the page is 2.4 MB of inlined renderer, so on a
    // loaded machine it can still be parsing at 250 ms, and a post that lands
    // before its listener exists is dropped. Latching there left the `ready`
    // that followed with nothing to do, and the deck never rendered (SHO-383).
    let answered = false
    const onReady = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      if (parseSlidesViewerMessage(event.data)?.type !== 'ready') return
      if (answered) return
      answered = true
      post()
    }
    window.addEventListener('message', onReady)
    // A page that was already ready before the bytes arrived (an iframe that
    // loaded from cache) never repeats `ready`, so post once on the next tick.
    const retry = setTimeout(() => {
      if (!answered) post()
    }, 250)
    return () => {
      window.removeEventListener('message', onReady)
      clearTimeout(retry)
    }
  }, [bytes, name])

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--ide-bg)]"
      data-testid="slides-preview"
    >
      <iframe
        ref={frameRef}
        title={name}
        // No `allow-same-origin`: the deck's HTML can never run on our origin.
        sandbox="allow-scripts"
        src={slidesViewerUrl(API_URL)}
        className="h-full w-full flex-1 border-0 bg-[color:var(--ide-bg)]"
        data-testid="slides-preview-frame"
        data-slide-count={state.status === 'ready' ? String(state.slideCount) : undefined}
      />
      {state.status === 'loading' ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[color:var(--ide-muted)]"
          data-testid="slides-preview-loading"
        >
          Rendering {name}…
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[color:var(--ide-bg)] p-6 text-center">
          <span className="text-[12px] text-[color:var(--ide-error)]" data-testid="slides-preview-error">
            {state.message}
          </span>
          <button
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            className="flex items-center gap-1 rounded border border-[color:var(--ide-border)] px-2 py-1 text-[11px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
          >
            <ExternalLink size={12} />
            Open the file
          </button>
        </div>
      ) : null}
    </div>
  )
}
