// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Image or video inside rendered chat markdown (web). Renders inline DOM
 * elements because Streamdown places images inside paragraphs.
 */
import React, { Suspense, lazy, useState } from "react"
import {
  useMarkdownImageUri,
  useMarkdownMedia,
  useMarkdownVideoUrl,
  type MarkdownMediaTarget,
} from "./markdown-media"

const ImagePreviewModal = lazy(() => import("./ImagePreviewModal").then((m) => ({ default: m.ImagePreviewModal })))

const MEDIA_CLASS = "my-1 block max-h-[420px] max-w-full rounded-md border border-border"

function Unavailable({ label }: { label: string }) {
  return (
    <span
      data-testid="chat-media-unavailable"
      className="inline-block rounded bg-muted px-2 py-1 text-sm text-muted-foreground"
    >
      Image unavailable: {label}
    </span>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <span
      data-testid="chat-media-loading"
      aria-label={`Loading ${label}`}
      className="inline-block h-24 w-40 animate-pulse rounded-md bg-muted"
    />
  )
}

function MarkdownImage({ target }: { target: MarkdownMediaTarget }) {
  const uri = useMarkdownImageUri(target)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  if (!target.url || failed) return <Unavailable label={target.label} />
  if (!uri) return <Loading label={target.label} />
  return (
    <>
      <img
        src={uri}
        alt={target.label}
        title={target.label}
        data-testid="chat-media-image"
        className={`${MEDIA_CLASS} cursor-zoom-in object-contain`}
        onError={() => setFailed(true)}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <Suspense fallback={null}>
          <ImagePreviewModal
            visible
            onClose={() => setOpen(false)}
            url={uri}
            title={target.label}
            alt={target.label}
          />
        </Suspense>
      ) : null}
    </>
  )
}

function MarkdownVideo({ target }: { target: MarkdownMediaTarget }) {
  const { url, failed } = useMarkdownVideoUrl(target)
  const [errored, setErrored] = useState(false)
  if (!target.url || failed || errored) return <Unavailable label={target.label} />
  if (!url) return <Loading label={target.label} />
  return (
    <video
      src={url}
      controls
      preload="metadata"
      title={target.label}
      aria-label={target.label}
      data-testid="chat-media-video"
      className={`${MEDIA_CLASS} bg-black`}
      onError={() => setErrored(true)}
    />
  )
}

export function MarkdownMedia({ src, alt }: { src?: string | null; alt?: string | null }) {
  const target = useMarkdownMedia(src, alt)
  return target.kind === "video" ? <MarkdownVideo target={target} /> : <MarkdownImage target={target} />
}
