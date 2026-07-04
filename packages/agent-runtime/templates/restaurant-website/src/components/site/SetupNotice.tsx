// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Sparkles } from 'lucide-react'

/**
 * Shown at the top of the site until the owner's REAL details have been
 * filled into `src/data/site-content.ts` and `configured` set to true.
 * It exists so a half-built site never masquerades as a finished, published
 * page full of made-up details.
 */
export function SetupNotice() {
  return (
    <div className="border-b border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/30">
      <div className="mx-auto max-w-6xl px-6 py-3">
        <Alert className="border-none bg-transparent p-0">
          <Sparkles className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-900 dark:text-amber-200">
            This site is showing sample structure — not your real details yet
          </AlertTitle>
          <AlertDescription className="text-amber-800/90 dark:text-amber-200/80">
            Tell me your business name, address, opening hours, menu, and any photos and I'll fill
            everything in. I won't invent menu items, prices, or hours — every detail comes from you.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  )
}
