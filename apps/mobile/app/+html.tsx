// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ScrollViewStyleReset } from 'expo-router/html'
import type { PropsWithChildren } from 'react'

export default function Root({ children }: PropsWithChildren) {
  const buildHash = process.env.EXPO_PUBLIC_BUILD_HASH || 'dev'
  return (
    <html lang="en" translate="no" className="notranslate">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="google" content="notranslate" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <link rel="icon" href={`/favicon.ico?v=${encodeURIComponent(buildHash)}`} />

        {/* Analytics scripts (Rewardful, GA4, FB Pixel) are injected post-export
            by scripts/inject-analytics.js — Expo "single" mode strips <script>
            tags from this file during export. */}

        <ScrollViewStyleReset />
        {/*
         * `ScrollViewStyleReset` only sets `overflow:hidden` on `body`, not
         * `html`. On mobile Safari/Chrome that's not enough: per spec,
         * `overflow` on the root element only clips the viewport when set on
         * `html` (`overflow:clip`/hidden on `body` alone does not propagate)
         * — https://github.com/w3c/csswg-drafts (root vs. body overflow
         * propagation). Any descendant that's even slightly wider than the
         * viewport (an unclamped file-tree row, a wide table, etc.) can make
         * the browser widen its *layout viewport* to fit that content,
         * which flips `window.innerWidth`/`useWindowDimensions().width` past
         * the `isWide`/tablet breakpoint on an otherwise normal phone —
         * swapping in the desktop sidebar and hiding the bottom nav. Setting
         * `overflow-x: hidden` on `html` is the standard fix (`overflow-x:
         * clip` is not enough; it isn't propagated to the viewport either).
         */}
        <style
          id="shogo-html-overflow-fix"
          dangerouslySetInnerHTML={{
            __html: `html{overflow-x:hidden;max-width:100vw}`,
          }}
        />
      </head>
      <body>
        {children}
      </body>
    </html>
  )
}
