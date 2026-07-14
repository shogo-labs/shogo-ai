// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface ChatAttachmentFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export interface ProcessChatAttachmentOptions {
  currentCount: number
  maxFiles: number
  maxFileSizeBytes: number
}

export interface ProcessChatAttachmentResult {
  files: ChatAttachmentFile[]
  errors: string[]
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".avi",
  ".mkv",
  ".mpeg",
  ".mpg",
  ".3gp",
])

const MAX_VIDEO_FRAME_ATTACHMENTS = 8
const VIDEO_FRAME_CANDIDATES = 14
const FRAME_HASH_SIZE = 8
const FRAME_HASH_DUPLICATE_DISTANCE = 6
const FRAME_MAX_WIDTH = 768
const FRAME_JPEG_QUALITY = 0.72

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

export function isVideoAttachment(type?: string, name?: string): boolean {
  const normalizedType = (type || "").toLowerCase()
  if (normalizedType.startsWith("video/")) return true
  return !!name && VIDEO_EXTENSIONS.has(extensionOf(name))
}

export function isImageAttachment(type?: string): boolean {
  return (type || "").toLowerCase().startsWith("image/")
}

export function isArchiveAttachment(type?: string, name?: string): boolean {
  const lowerName = (name || "").toLowerCase()
  return (
    lowerName.endsWith(".zip") ||
    lowerName.endsWith(".shogo") ||
    lowerName.endsWith(".shogo-project") ||
    type === "application/zip" ||
    type === "application/x-zip-compressed"
  )
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ""))
    reader.onerror = () => reject(reader.error || new Error("Could not read file"))
    reader.readAsDataURL(file)
  })
}

function loadVideo(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video") as any
    video.preload = "metadata"
    video.muted = true
    video.playsInline = true
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error("Could not load video metadata"))
    video.src = url
  })
}

function seekVideo(video: any, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked)
      video.removeEventListener("error", onError)
    }
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error("Could not seek video"))
    }
    video.addEventListener("seeked", onSeeked, { once: true })
    video.addEventListener("error", onError, { once: true })
    video.currentTime = time
  })
}

function frameHash(canvas: any): string {
  const hashCanvas = document.createElement("canvas") as any
  hashCanvas.width = FRAME_HASH_SIZE
  hashCanvas.height = FRAME_HASH_SIZE
  const ctx = hashCanvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return ""
  ctx.drawImage(canvas, 0, 0, FRAME_HASH_SIZE, FRAME_HASH_SIZE)
  const pixels = ctx.getImageData(0, 0, FRAME_HASH_SIZE, FRAME_HASH_SIZE).data
  const values: number[] = []
  for (let i = 0; i < pixels.length; i += 4) {
    values.push((pixels[i] * 0.299) + (pixels[i + 1] * 0.587) + (pixels[i + 2] * 0.114))
  }
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  return values.map((value) => (value >= avg ? "1" : "0")).join("")
}

function hammingDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++
  }
  return distance
}

function isDuplicateFrame(hash: string, hashes: string[]): boolean {
  return hashes.some((existing) => hammingDistance(hash, existing) <= FRAME_HASH_DUPLICATE_DISTANCE)
}

function safeBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "video"
}

function encodeUtf8Base64(value: string): string {
  if (typeof btoa !== "function" || typeof TextEncoder === "undefined") return ""
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000))
  }
  return btoa(binary)
}

function buildVideoContextAttachment(video: {
  name: string
  type: string
  size: number
  duration?: number
  width?: number
  height?: number
  frameCount: number
  frameTimes: number[]
  frameExtractionError?: string
}): ChatAttachmentFile {
  const lines = [
    `Video attachment: ${video.name}`,
    `Media type: ${video.type || "video/unknown"}`,
    `Size: ${formatAttachmentSize(video.size)}`,
    Number.isFinite(video.duration) ? `Duration: ${video.duration!.toFixed(2)} seconds` : "Duration: unavailable",
    video.width && video.height ? `Resolution: ${video.width}x${video.height}` : "Resolution: unavailable",
    `Representative frames attached for vision: ${video.frameCount}`,
    video.frameTimes.length > 0
      ? `Frame timestamps: ${video.frameTimes.map((t) => `${t.toFixed(2)}s`).join(", ")}`
      : "Frame timestamps: none",
    video.frameExtractionError ? `Frame extraction warning: ${video.frameExtractionError}` : null,
    "The frame set was sampled across the video and near-duplicate frames were removed before sending to the model.",
    "Use the saved original video file if more detail, audio, transcript, or exact timing is needed.",
  ].filter(Boolean).join("\n")
  const encoded = encodeUtf8Base64(lines)
  return {
    id: uid(),
    dataUrl: `data:text/plain;base64,${encoded}`,
    name: `${safeBaseName(video.name)}.video-context.txt`,
    type: "text/plain",
    size: lines.length,
  }
}

async function extractVideoFrameAttachments(file: File): Promise<{
  frames: ChatAttachmentFile[]
  duration?: number
  width?: number
  height?: number
  times: number[]
  error?: string
}> {
  if (typeof document === "undefined") {
    return { frames: [], times: [], error: "Video frame extraction is unavailable on this platform." }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const video = await loadVideo(objectUrl)
    const duration = Number(video.duration)
    const width = Number(video.videoWidth) || undefined
    const height = Number(video.videoHeight) || undefined
    if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
      return { frames: [], duration, width, height, times: [], error: "Video metadata is incomplete." }
    }

    const canvas = document.createElement("canvas") as any
    const scale = Math.min(1, FRAME_MAX_WIDTH / width)
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) {
      return { frames: [], duration, width, height, times: [], error: "Canvas is unavailable." }
    }

    const frameTarget = Math.min(MAX_VIDEO_FRAME_ATTACHMENTS, VIDEO_FRAME_CANDIDATES)
    const candidates = Array.from({ length: VIDEO_FRAME_CANDIDATES }, (_, i) => {
      const ratio = (i + 1) / (VIDEO_FRAME_CANDIDATES + 1)
      return Math.min(Math.max(duration * ratio, 0), Math.max(duration - 0.05, 0))
    })
    const hashes: string[] = []
    const frames: ChatAttachmentFile[] = []
    const times: number[] = []
    const baseName = safeBaseName(file.name)

    for (const time of candidates) {
      if (frames.length >= frameTarget) break
      await seekVideo(video, time)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const hash = frameHash(canvas)
      if (hash && isDuplicateFrame(hash, hashes)) continue
      hashes.push(hash)
      const dataUrl = canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY)
      frames.push({
        id: uid(),
        dataUrl,
        name: `${baseName}.frame-${String(frames.length + 1).padStart(2, "0")}-${time.toFixed(2)}s.jpg`,
        type: "image/jpeg",
        size: Math.ceil((dataUrl.length * 3) / 4),
      })
      times.push(time)
    }

    if (frames.length === 0 && candidates.length > 0) {
      const time = candidates[0]
      await seekVideo(video, time)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY)
      frames.push({
        id: uid(),
        dataUrl,
        name: `${baseName}.frame-01-${time.toFixed(2)}s.jpg`,
        type: "image/jpeg",
        size: Math.ceil((dataUrl.length * 3) / 4),
      })
      times.push(time)
    }

    return { frames, duration, width, height, times }
  } catch (err) {
    return {
      frames: [],
      times: [],
      error: err instanceof Error ? err.message : "Video frames could not be extracted.",
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function processChatAttachmentFiles(
  inputFiles: FileList | File[],
  options: ProcessChatAttachmentOptions,
): Promise<ProcessChatAttachmentResult> {
  const files = Array.from(inputFiles)
  const out: ChatAttachmentFile[] = []
  const errors: string[] = []
  let used = options.currentCount

  const pushIfRoom = (file: ChatAttachmentFile): boolean => {
    if (used >= options.maxFiles) {
      errors.push(`Maximum ${options.maxFiles} files allowed`)
      return false
    }
    out.push(file)
    used++
    return true
  }

  for (const file of files) {
    const type = file.type || "application/octet-stream"
    const isExempt = isArchiveAttachment(type, file.name)
    if (!isExempt && file.size > options.maxFileSizeBytes) {
      errors.push(`File "${file.name}" exceeds ${options.maxFileSizeBytes / (1024 * 1024)}MB limit`)
      continue
    }

    let dataUrl: string
    try {
      dataUrl = await readFileAsDataUrl(file)
    } catch {
      errors.push(`Could not read "${file.name}"`)
      continue
    }

    if (!pushIfRoom({ id: uid(), dataUrl, name: file.name, type, size: file.size })) continue

    if (!isVideoAttachment(type, file.name)) continue

    const analysis = await extractVideoFrameAttachments(file)
    const remainingForDerived = options.maxFiles - used
    const frameRoom = Math.max(0, remainingForDerived - 1)
    const framesToAttach = analysis.frames.slice(0, frameRoom)
    for (const frame of framesToAttach) pushIfRoom(frame)

    const context = buildVideoContextAttachment({
      name: file.name,
      type,
      size: file.size,
      duration: analysis.duration,
      width: analysis.width,
      height: analysis.height,
      frameCount: framesToAttach.length,
      frameTimes: analysis.times.slice(0, framesToAttach.length),
      frameExtractionError: analysis.error,
    })
    pushIfRoom(context)
  }

  return { files: out, errors: Array.from(new Set(errors)) }
}
