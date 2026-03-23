// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ScrollViewStyleReset } from 'expo-router/html'
import type { PropsWithChildren } from 'react'

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        {/* Analytics scripts (Rewardful, GA4, FB Pixel) are injected post-export
            by scripts/inject-analytics.js — Expo "single" mode strips <script>
            tags from this file during export. */}

        <ScrollViewStyleReset />
      </head>
      <body>
        {children}
      </body>
    </html>
  )
}
