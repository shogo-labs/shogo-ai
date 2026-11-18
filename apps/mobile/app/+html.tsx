// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ScrollViewStyleReset } from 'expo-router/html'
import type { PropsWithChildren } from 'react'

import {
  LANDSCAPE_OVERLAY_HTML,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  VIEWPORT_META_CONTENT,
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
} from '../scripts/web-shell-guards'

// NOTE: `app.json` sets `web.output: "single"`, so the *exported* shell does not
// come from this file — it is Expo's default template. Everything below is kept
// for the dev server and for a future switch to `output: "static"`, and
// `scripts/inject-analytics.js` builds the same head/body for `dist/index.html`
// from these same strings. Change one and the other follows.

export default function Root({ children }: PropsWithChildren) {
  const buildHash = process.env.EXPO_PUBLIC_BUILD_HASH || 'dev'
  return (
    <html lang="en" translate="no" className="notranslate">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="google" content="notranslate" />
        {/* Phone zoom is stopped by the phone-scoped CSS and script below, not by
            the viewport meta (SHO-405). This meta is global: `maximum-scale=1` /
            `user-scalable=no` would also lock real pinch on iPad-sized Blink
            tablets, and iOS has ignored them for pinch since iOS 10 anyway. */}

        <meta name="viewport" content={VIEWPORT_META_CONTENT} />
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
