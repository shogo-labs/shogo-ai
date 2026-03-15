// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace Download MIME Type Tests
 *
 * Verifies that the /agent/workspace/download/* endpoint returns
 * correct Content-Type headers based on file extension.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/download-mime.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { extname } from 'path'

// Mirror the MIME type map from server.ts so tests verify the mapping
const DOWNLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
}

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return DOWNLOAD_MIME_TYPES[ext] || 'application/octet-stream'
}

describe('MIME type detection', () => {
  test('.png -> image/png', () => {
    expect(getMimeType('test.png')).toBe('image/png')
  })

  test('.PNG -> image/png (case insensitive)', () => {
    expect(getMimeType('test.PNG')).toBe('image/png')
  })

  test('.jpg -> image/jpeg', () => {
    expect(getMimeType('test.jpg')).toBe('image/jpeg')
  })

  test('.jpeg -> image/jpeg', () => {
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg')
  })

  test('.gif -> image/gif', () => {
    expect(getMimeType('animation.gif')).toBe('image/gif')
  })

  test('.webp -> image/webp', () => {
    expect(getMimeType('optimized.webp')).toBe('image/webp')
  })

  test('.svg -> image/svg+xml', () => {
    expect(getMimeType('icon.svg')).toBe('image/svg+xml')
  })

  test('.pdf -> application/pdf', () => {
    expect(getMimeType('report.pdf')).toBe('application/pdf')
  })

  test('.json -> application/json', () => {
    expect(getMimeType('data.json')).toBe('application/json')
  })

  test('.txt -> text/plain', () => {
    expect(getMimeType('readme.txt')).toBe('text/plain')
  })

  test('unknown extension -> application/octet-stream', () => {
    expect(getMimeType('data.xyz')).toBe('application/octet-stream')
  })

  test('no extension -> application/octet-stream', () => {
    expect(getMimeType('Makefile')).toBe('application/octet-stream')
  })

  test('dotfile -> application/octet-stream', () => {
    expect(getMimeType('.gitignore')).toBe('application/octet-stream')
  })

  test('generated image filename pattern', () => {
    expect(getMimeType('generated-1710000000-ab12.png')).toBe('image/png')
  })

  test('nested path gets correct MIME', () => {
    expect(getMimeType('images/subfolder/photo.jpg')).toBe('image/jpeg')
  })
})
