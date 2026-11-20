// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A sandboxed office-document preview: PowerPoint slides (SHO-426) or Word
 * pages (SHO-467) rendered in a sandboxed iframe.
 *
 * The renderer writes untrusted document content into the DOM with `innerHTML`,
 * so it never runs on the app's origin: the iframe is `sandbox="allow-scripts"`
 * (no `allow-same-origin`, so its origin is opaque) and the page it loads
 * carries `Content-Security-Policy: sandbox` from the API, which keeps that
 * true even where the frame is loaded top-level. The file's bytes are fetched
 * here, with the app's own credentials, and posted in — the frame never
 * fetches anything and the file never appears in a URL.
 *
 * Web only. On iOS and Android `FileContentView` mounts `NativeOffice` on the
 * same page.
 */

import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react-native'
import { API_URL } from '../../../../lib/api-url'
import {
  SLIDES_RENDER_TIMEOUT_MS,
  fetchSlidesBytes,
  parseSlidesViewerMessage,
  parseDocumentViewerMessage,
  slidesLoadMessage,
  slidesPreviewErrorText,
  slidesViewerUrl,
  documentViewerUrl,
  type SlidesTheme,
} from './slides-viewer-protocol'

export { isSlidesPath } from './slides-viewer-protocol'
export { isDocumentPath } from './slides-viewer-protocol'

type OfficeKind = 'slides' | 'document'

function viewerUrl(kind: OfficeKind): string {
  return kind === 'slides' ? slidesViewerUrl(API_URL) : documentViewerUrl(API_URL)
}

function parseViewerMessage(kind: OfficeKind, data: unknown) {
  return kind === 'slides'
    ? parseSlidesViewerMessage(data)
    : parseDocumentViewerMessage(data)
}

function itemCount(msg: ReturnType<typeof parseSlidesViewerMessage> | ReturnType<typeof parseDocumentViewerMessage>): number {
  if (!msg || msg.type !== 'rendered') return 0
  if ('slideCount' in msg) return msg.slideCount
  if ('itemCount' in msg) return msg.itemCount
  return 0
}

export function OfficePreview({
  kind,
  url,
  name,
  onError,
}: {
  kind: OfficeKind
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
    | { status: 'ready'; count: number }
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

  // Only our own frame may talk to us.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const message = parseViewerMessage(kind, event.data)
      if (!message) return
      if (message.type === 'rendered') setState({ status: 'ready', count: itemCount(message) })
      else if (message.type === 'error') {
        setState({ status: 'error', message: message.message })
        onError?.(message.message)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [kind, onError])

  // Nothing arrives within the cap: stop waiting rather than spin forever.
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
    const theme: SlidesTheme =
      rootRef.current?.closest('[data-theme]')?.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    const post = (transfer: boolean) => {
      const target = frame.contentWindow
      if (!target) return
      const { message, transfer: list } = slidesLoadMessage(name, theme, bytes)
      target.postMessage(message, '*', transfer ? list : [])
    }
    let answered = false
    const onReady = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      if (parseViewerMessage(kind, event.data)?.type !== 'ready') return
      if (answered) return
      answered = true
      post(true)
    }
    window.addEventListener('message', onReady)
    const retry = setTimeout(() => {
      if (!answered) post(false)
    }, 250)
    return () => {
      window.removeEventListener('message', onReady)
      clearTimeout(retry)
    }
  }, [bytes, name, kind])

  const testIdBase = kind === 'slides' ? 'slides-preview' : 'document-preview'

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--ide-bg)]"
      data-testid={testIdBase}
    >
      <iframe
        ref={frameRef}
        title={name}
        sandbox="allow-scripts"
        src={viewerUrl(kind)}
        className="h-full w-full flex-1 border-0 bg-[color:var(--ide-bg)]"
        data-testid={`${testIdBase}-frame`}
        data-item-count={state.status === 'ready' ? String(state.count) : undefined}
      />
      {state.status === 'loading' ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[color:var(--ide-muted)]"
          data-testid={`${testIdBase}-loading`}
        >
          Rendering {name}…
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[color:var(--ide-bg)] p-6 text-center">
          <span className="text-[12px] text-[color:var(--ide-error)]" data-testid={`${testIdBase}-error`}>
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
