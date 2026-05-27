// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import { isBinaryFilePath, BINARY_FILE_EXTENSIONS } from '../file-types.js'

describe('isBinaryFilePath', () => {
  it('returns true for common binary extensions', () => {
    expect(isBinaryFilePath('photo.png')).toBe(true)
    expect(isBinaryFilePath('video.mp4')).toBe(true)
    expect(isBinaryFilePath('archive.zip')).toBe(true)
    expect(isBinaryFilePath('model.onnx')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isBinaryFilePath('PHOTO.PNG')).toBe(true)
    expect(isBinaryFilePath('archive.ZIP')).toBe(true)
  })

  it('handles full paths with slashes', () => {
    expect(isBinaryFilePath('/abs/path/to/photo.png')).toBe(true)
    expect(isBinaryFilePath('rel/photo.png')).toBe(true)
    expect(isBinaryFilePath('C:\\Users\\me\\photo.png')).toBe(true)
  })

  it('returns false for text/code extensions', () => {
    expect(isBinaryFilePath('file.txt')).toBe(false)
    expect(isBinaryFilePath('app.ts')).toBe(false)
    expect(isBinaryFilePath('config.json')).toBe(false)
    expect(isBinaryFilePath('script.py')).toBe(false)
  })

  it('returns false for files with no extension', () => {
    expect(isBinaryFilePath('README')).toBe(false)
    expect(isBinaryFilePath('/path/Makefile')).toBe(false)
  })

  it('returns false when "." appears in the directory but not the basename', () => {
    expect(isBinaryFilePath('/path/with.dot/filename')).toBe(false)
    expect(isBinaryFilePath('C:\\path.d\\filename')).toBe(false)
  })

  it('returns false for text variants intentionally excluded (.usda, .gltf, .svg)', () => {
    expect(isBinaryFilePath('scene.usda')).toBe(false)
    expect(isBinaryFilePath('model.gltf')).toBe(false)
    expect(isBinaryFilePath('icon.svg')).toBe(false)
  })

  it('binary set contains expected categories', () => {
    expect(BINARY_FILE_EXTENSIONS.has('png')).toBe(true)
    expect(BINARY_FILE_EXTENSIONS.has('wasm')).toBe(true)
    expect(BINARY_FILE_EXTENSIONS.has('parquet')).toBe(true)
    expect(BINARY_FILE_EXTENSIONS.has('safetensors')).toBe(true)
    expect(BINARY_FILE_EXTENSIONS.has('mcap')).toBe(true)
    expect(BINARY_FILE_EXTENSIONS.has('ts')).toBe(false)
  })
})
