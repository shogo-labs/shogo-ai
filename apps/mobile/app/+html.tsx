// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ScrollViewStyleReset } from 'expo-router/html'
import type { PropsWithChildren } from 'react'

import {
  LANDSCAPE_OVERLAY_HTML,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
} from '../scripts/web-shell-guards'

export default function Root({ children }: PropsWithChildren) {
  const buildHash = process.env.EXPO_PUBLIC_BUILD_HASH || 'dev'
  return (
    <html lang="en" translate="no" className="notranslate">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="google" content="notranslate" />
        {/* No pinch / no double-tap zoom on phones (SHO-405). iOS Safari has
            ignored user-scalable/maximum-scale for *pinch* since iOS 10 — that
            one is stopped by the guard script below — but it still honours
            maximum-scale=1 for input-focus auto-zoom, which the
            16px-minimum input rule further down also prevents. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, shrink-to-fit=no, viewport-fit=cover"
        />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href={`/favicon.ico?v=${encodeURIComponent(buildHash)}`} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                try {
                  const preference = window.localStorage.getItem('theme-preference')
                  const isDark =
                    preference === 'dark' ||
                    (preference !== 'light' &&
                      window.matchMedia('(prefers-color-scheme: dark)').matches)
                  if (isDark) document.documentElement.classList.add('dark')
                } catch {}
              })()
            `,
          }}
        />

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
            __html: `html{overflow-x:hidden;max-width:100vw;background-color:#FFFFFF}html.dark{background-color:#121212}`,
          }}
        />
        {/*
         * Phone viewport guard (SHO-405): pinch/double-tap zoom off, a 16px
         * minimum on form controls so iOS never auto-zooms a focused input,
         * and the landscape rotate prompt. See
         * `scripts/web-shell-guards.js` for why each rule is needed.
         */}
        <style
          id={PHONE_GUARD_STYLE_ID}
          dangerouslySetInnerHTML={{ __html: PHONE_VIEWPORT_GUARD_CSS }}
        />
        {/* Expo's "single" export strips <script> tags from this file, so
            `scripts/inject-analytics.js` injects the same guard post-export —
            it reads the source from `scripts/web-shell-guards.js`. */}
        <script
          {...{ [ZOOM_GUARD_ATTRIBUTE]: true }}
          dangerouslySetInnerHTML={{ __html: ZOOM_GUARD_SCRIPT }}
        />
      </head>
      <body>
        {children}
        {/* `display: contents` keeps the prompt a direct layout child of the
            page while its markup stays in one place
            (`scripts/web-shell-guards.js`) — the post-export step injects the
            same markup if Expo's export drops it. */}
        <div
          style={{ display: 'contents' }}
          dangerouslySetInnerHTML={{ __html: LANDSCAPE_OVERLAY_HTML }}
        />
      </body>
    </html>
  )
}
