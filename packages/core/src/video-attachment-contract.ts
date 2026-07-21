// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
  '.mpeg',
  '.mpg',
  '.3gp',
] as const

export const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/mpeg',
  'video/3gpp',
] as const

export const VIDEO_DERIVED_ATTACHMENT = {
  contextSuffix: '.video-context.txt',
  frameNamePattern: '.frame-',
  maxFrames: 8,
  frameCandidates: 14,
  maxFrameWidth: 768,
  jpegQuality: 0.72,
} as const

export const VIDEO_PROCESSING_LIMITS = {
  maxClientVideoBytes: 10 * 1024 * 1024,
  maxServerVideoBytes: 50 * 1024 * 1024,
  maxVideoDurationSeconds: 180,
  maxVideosPerMessage: 3,
  maxProcessingJobsPerWorkspace: 3,
} as const

export type VideoExtension = typeof VIDEO_EXTENSIONS[number]
export type VideoMimeType = typeof VIDEO_MIME_TYPES[number]

const VIDEO_EXTENSION_SET = new Set<string>(VIDEO_EXTENSIONS)

export function getFileExtension(name?: string): string {
  if (!name) return ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function isVideoMimeType(mediaType?: string): boolean {
  return (mediaType || '').toLowerCase().startsWith('video/')
}

export function isVideoFileName(name?: string): boolean {
  return VIDEO_EXTENSION_SET.has(getFileExtension(name))
}

export function isVideoAttachmentType(mediaType?: string, name?: string): boolean {
  return isVideoMimeType(mediaType) || isVideoFileName(name)
}

export function videoMimeTypeFromName(name: string): VideoMimeType | undefined {
  const extension = getFileExtension(name)
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.webm') return 'video/webm'
  if (extension === '.avi') return 'video/x-msvideo'
  if (extension === '.mkv') return 'video/x-matroska'
  if (extension === '.mpeg' || extension === '.mpg') return 'video/mpeg'
  if (extension === '.3gp') return 'video/3gpp'
  return undefined
}
