/**
 * IntentTerminalSection Component
 * Task: task-cpv-006
 *
 * Section component that renders feature.intent in terminal styling.
 * Extracted from DiscoveryView's IntentTerminal pattern for use in
 * the composable phase views system.
 *
 * Features:
 * - Terminal-style monospace formatting
 * - Green text on dark background (zinc-900)
 * - Handles undefined/empty intent gracefully
 * - Preserves whitespace for multiline intents
 */

import { Terminal } from "lucide-react"
import type { SectionRendererProps } from "../sectionImplementations"

/**
 * IntentTerminalSection - Terminal-style display for feature intent
 *
 * Renders the feature's intent property with a command-line aesthetic:
 * - Dark background with blue border
 * - Terminal header bar with icon and character count
 * - Green monospace text with cursor animation
 *
 * @param feature - The feature session data containing intent
 * @param config - Optional configuration (reserved for future use)
 */
export function IntentTerminalSection({
  feature,
  config,
}: SectionRendererProps) {
  // Safely extract intent, handling null/undefined feature
  const intent = feature?.intent ?? ""
  const displayIntent = intent || "No intent specified"
  const charCount = displayIntent.length

  return (
    <div
      data-testid="intent-terminal-section"
      className="rounded-lg overflow-hidden border border-blue-500/30"
    >
      {/* Terminal header bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-700">
        <Terminal className="h-4 w-4 text-blue-400" />
        <span className="text-xs font-medium text-blue-400 uppercase tracking-wider">
          Mission Intent
        </span>
        <div className="flex-1" />
        <span className="text-xs text-zinc-500">{charCount} chars</span>
      </div>

      {/* Terminal content */}
      <div className="bg-zinc-900 p-4">
        <pre className="font-mono text-sm text-green-400 whitespace-pre-wrap leading-relaxed">
          <span className="text-blue-400">$ </span>
          {displayIntent}
          <span className="animate-pulse text-green-400">_</span>
        </pre>
      </div>
    </div>
  )
}
