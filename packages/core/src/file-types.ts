// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canonical "is this file binary on disk?" predicate.
 *
 * One source of truth for the agent-runtime, the IDE Workbench, the live-
 * agent-edit sync, and the local filesystem layer. Before this module
 * existed, four parallel extension sets had drifted apart:
 *
 *   - `packages/agent-runtime/src/server.ts:BINARY_FILE_EXTENSIONS`
 *   - `apps/mobile/.../useLiveAgentEdits.ts:NON_TEXT_EXTENSIONS`
 *   - `apps/mobile/.../Workbench.tsx:BINARY_EXTENSIONS`
 *   - `apps/mobile/.../workspace/localFs.ts:BINARY_EXT`
 *
 * That drift caused real corruption bugs (e.g. `.usd` files silently
 * round-tripped as utf-8, then `EUNKNOWN` on writeFileSync; `.mp4` /
 * `.zip` doubled in size on the agent-runtime PUT path).
 *
 * Why an extension allow-list and not a content sniff: the write path
 * has to decide encoding *before* it sees bytes. A content sniff is
 * useful as a secondary signal on read (see `localFs.looksLikeText`),
 * but the wire-format encoding is fundamentally a property of the path.
 *
 * Zero peers, zero deps, runs in Bun / Node / Metro / browser.
 */

/** Extensions that must be sent over the wire as base64 (binary) instead
 *  of utf-8. A file with one of these extensions:
 *
 *  - cannot be read as utf-8 without producing U+FFFD replacement chars,
 *  - cannot be written from utf-8 string content without corrupting the
 *    on-disk bytes (the classic "2x bloat" round-trip bug),
 *  - should not be opened in Monaco unless we have a dedicated previewer
 *    for it (image/pdf/audio/video/font/sqlite — handled at call sites).
 *
 *  Conservative additions only: a format goes in here when its **binary
 *  encoding is the dominant on-disk form**. Formats with widely-used
 *  ASCII variants (`.usda`, `.gltf`, `.dae`, `.urdf`, `.mjcf`, plain
 *  `.svg`, plain `.obj`) are intentionally absent so users can still
 *  edit them as text.
 *
 *  When you add a new entry, prefer adding it to the right category
 *  comment so the next person reading this file can tell at a glance
 *  whether they need to add their own format. */
export const BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'apng',
  'heic', 'heif', 'tiff', 'tif', 'jxl', 'cur',
  // Archives
  'zip', 'gz', 'tar', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4',
  // Audio / video / docs
  'mp3', 'mp4', 'm4a', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac',
  'ogg', 'oga', 'ogv', 'aac', 'opus', 'pdf',
  // Fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // Native / packed
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm',
  // Databases
  'db', 'sqlite', 'sqlite3', 'mdb', 'lmdb',
  // Misc binary
  'pack', 'idx', 'psd', 'ai', 'sketch', 'fig', 'blend', 'obj', 'fbx',
  'pyc', 'pyo', 'pyd',
  // 3D / scene / point cloud (binary variants — `.usda` and `.gltf` are
  // text and intentionally NOT listed; users can still edit those)
  'usd', 'usdc', 'usdz', 'glb', 'stl', 'ply',
  // Robotics logs
  'bag', 'mcap',
  // ML weights / saved models / serialized arrays
  'pt', 'pth', 'ckpt', 'safetensors', 'onnx', 'pb', 'tflite', 'mlmodel',
  'npy', 'npz', 'joblib', 'pkl',
  // Tabular / scientific containers
  'parquet', 'arrow', 'feather', 'h5', 'hdf5', 'nc', 'tfrecord',
])

/** True iff `path`'s extension is in {@link BINARY_FILE_EXTENSIONS}.
 *  Case-insensitive; tolerant of paths with no extension (returns
 *  false). Operates purely on the suffix — does not stat the file. */
export function isBinaryFilePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot < slash) return false
  return BINARY_FILE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}
