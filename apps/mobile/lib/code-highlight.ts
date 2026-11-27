// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one place the app loads syntax highlighting.
 *
 * `shiki` is a few megabytes of grammars, and nothing on the first paint of
 * Home, a channel or a project needs it. So it is loaded on demand, from one
 * call site: two separate `import("shiki")` call sites made Metro treat some of
 * the grammars as shared between chunks and hoist them into `__common`, which
 * every cold start parses.
 *
 * The `import()` lives in `./code-highlight-shiki` rather than here because
 * this module is part of `__common`, and a dynamic import written in a common
 * module is folded into that chunk.
 */
import type { HighlighterCore } from 'shiki/core'

let loader: Promise<HighlighterCore> | null = null

export function loadHighlighter(): Promise<HighlighterCore> {
  loader ??= import('./code-highlight-shiki').then((module) => module.getHighlighter())
  return loader
}
