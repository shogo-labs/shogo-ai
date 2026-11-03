// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Content type for a file the desktop serves off its own disk. Shared by the
 * token download route (`/api/f/<token>`) and the local-only read route
 * (`/api/local-files`), so a `.mp4` plays and a `.md` previews on both.
 */

import { extname } from 'path'

export const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  // Media and fonts: the app fetches these bytes and plays or draws them
  // itself, so an octet-stream answer leaves `<video>`/`<audio>` with no
  // decoder to pick. Cloud passes the storage type through — this table is
  // what keeps desktop honest (SHO-165).
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export function mimeTypeForFile(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream'
}
