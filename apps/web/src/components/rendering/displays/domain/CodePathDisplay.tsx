/**
 * CodePathDisplay - Renders file paths with monospace styling
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl
 * - truncate: number (default: 60) - truncates from the beginning to show filename
 * - clickable: boolean (copy to clipboard on click)
 *
 * Task: smart-component-expansion
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { cn } from "@/lib/utils"
import { FileCode, Copy, Check } from "lucide-react"
import type { DisplayRendererProps, XRendererConfig } from "../../types"

const DEFAULT_TRUNCATE = 60

const sizeClasses: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl"
}

const iconSizes: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
  xl: "h-6 w-6"
}

/**
 * Extracts just the filename from a path.
 */
function getFileName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || path
}

/**
 * Truncates a path from the beginning to preserve the filename.
 * Returns "...partial/path/to/file.ts" format.
 */
function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) return path

  const fileName = getFileName(path)

  // If filename alone is longer than maxLength, just return truncated filename
  if (fileName.length >= maxLength - 3) {
    return `...${fileName.slice(-(maxLength - 3))}`
  }

  // Otherwise, truncate from the beginning
  const remaining = maxLength - fileName.length - 4 // 4 for ".../"
  if (remaining <= 0) {
    return `.../${fileName}`
  }

  // Try to find a good break point at a directory separator
  const pathWithoutFile = path.slice(0, path.length - fileName.length - 1)
  const truncatedDir = pathWithoutFile.slice(-remaining)

  // Clean up partial directory name at the start
  const slashIndex = truncatedDir.indexOf("/")
  const cleanDir = slashIndex > 0 ? truncatedDir.slice(slashIndex) : truncatedDir

  return `...${cleanDir}/${fileName}`
}

function CodePathDisplayComponent({
  value,
  config = {}
}: DisplayRendererProps) {
  const [copied, setCopied] = useState(false)

  const truncateLen = typeof config.truncate === "number"
    ? config.truncate
    : config.truncate === false
      ? undefined
      : DEFAULT_TRUNCATE

  const clickable = config.clickable ?? true
  const size = config.size ?? "xs"

  // Handle null/undefined values
  if (value == null || value === "") {
    return (
      <span className={cn("text-muted-foreground font-mono", sizeClasses[size])}>
        -
      </span>
    )
  }

  const path = String(value)
  const displayPath = truncateLen ? truncatePath(path, truncateLen) : path

  const handleCopy = async () => {
    if (!clickable) return

    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API not available
    }
  }

  const baseClassName = cn(
    "inline-flex items-center gap-1.5 font-mono rounded px-1.5 py-0.5",
    "bg-muted/50 text-muted-foreground",
    sizeClasses[size],
    clickable && "cursor-pointer hover:bg-muted hover:text-foreground transition-colors"
  )

  return (
    <span
      className={baseClassName}
      onClick={handleCopy}
      title={clickable ? `Click to copy: ${path}` : path}
    >
      <FileCode className={cn(iconSizes[size], "shrink-0")} />
      <span className="truncate">{displayPath}</span>
      {clickable && (
        copied ? (
          <Check className={cn(iconSizes[size], "shrink-0 text-green-500")} />
        ) : (
          <Copy className={cn(iconSizes[size], "shrink-0 opacity-50")} />
        )
      )}
    </span>
  )
}

export const CodePathDisplay = observer(CodePathDisplayComponent) as typeof CodePathDisplayComponent & {
  supportedConfig: string[]
}

CodePathDisplay.supportedConfig = ["size", "truncate", "clickable"]
