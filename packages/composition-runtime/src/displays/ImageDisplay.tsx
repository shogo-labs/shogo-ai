/**
 * ImageDisplay - Renders image URLs as visual images
 *
 * Supports XRendererConfig:
 * - size: xs, sm, md, lg, xl (controls dimensions)
 * - variant: default, muted (applies visual styling)
 * - aspectRatio: '1:1' | '16:9' | '4:3' | 'auto'
 * - objectFit: 'cover' | 'contain' | 'fill'
 * - clickable: opens lightbox on click
 *
 * Matching:
 * - Explicit: x-renderer: "image-display" (priority 200)
 * - Implicit: format: uri + name matches image/photo/avatar/etc (priority 40)
 * - Implicit: contentMediaType: image/* (priority 35)
 */

import { useState, useCallback, useEffect } from "react"
import { X } from "lucide-react"
import { observer } from "mobx-react-lite"
import { cn } from "../utils/cn"
import type { DisplayRendererProps, XRendererConfig } from "../types"

// Extended config for image-specific options
interface ImageConfig extends XRendererConfig {
  aspectRatio?: "1:1" | "16:9" | "4:3" | "auto"
  objectFit?: "cover" | "contain" | "fill"
  fallback?: string
}

// Size classes for the image container
const sizeClasses: Record<NonNullable<XRendererConfig["size"]>, string> = {
  xs: "w-8 h-8",
  sm: "w-12 h-12",
  md: "w-24 h-24",
  lg: "w-40 h-40",
  xl: "w-64 h-64",
}

// Aspect ratio classes
const aspectRatioClasses: Record<string, string> = {
  "1:1": "aspect-square",
  "16:9": "aspect-video",
  "4:3": "aspect-[4/3]",
  auto: "",
}

// Object fit classes
const objectFitClasses: Record<string, string> = {
  cover: "object-cover",
  contain: "object-contain",
  fill: "object-fill",
}

const variantClasses: Record<NonNullable<XRendererConfig["variant"]>, string> = {
  default: "",
  muted: "opacity-60",
  emphasized: "ring-2 ring-primary",
  warning: "ring-2 ring-amber-500",
  success: "ring-2 ring-green-500",
  error: "ring-2 ring-red-500",
}

// Placeholder SVG for broken images
const BrokenImagePlaceholder = ({ className }: { className?: string }) => (
  <div
    className={cn(
      "flex items-center justify-center bg-muted text-muted-foreground",
      className
    )}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-1/3 h-1/3 min-w-4 min-h-4"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  </div>
)

// Empty/null placeholder
const EmptyPlaceholder = ({ className }: { className?: string }) => (
  <div
    className={cn(
      "flex items-center justify-center bg-muted text-muted-foreground",
      className
    )}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-1/3 h-1/3 min-w-4 min-h-4"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  </div>
)

function ImageDisplayComponent({
  value,
  config = {},
}: DisplayRendererProps) {
  const [hasError, setHasError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const handleError = useCallback(() => {
    setHasError(true)
    setIsLoading(false)
  }, [])

  const handleLoad = useCallback(() => {
    setIsLoading(false)
  }, [])

  // Body scroll lock and escape key handler for fullscreen mode
  useEffect(() => {
    if (isFullscreen) {
      const previousOverflow = document.body.style.overflow
      document.body.style.overflow = "hidden"

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setIsFullscreen(false)
        }
      }
      document.addEventListener("keydown", handleKeyDown)

      return () => {
        document.body.style.overflow = previousOverflow
        document.removeEventListener("keydown", handleKeyDown)
      }
    }
  }, [isFullscreen])

  const size = config.size ?? "md"
  // Image-specific config from customProps or direct config
  const imageConfig = config.customProps as ImageConfig | undefined
  const aspectRatio = imageConfig?.aspectRatio ?? "1:1"
  const objectFit = imageConfig?.objectFit ?? "cover"
  const variant = config.variant ?? "default"
  const clickable = config.clickable ?? true

  const containerClassName = cn(
    "relative overflow-hidden rounded-md",
    sizeClasses[size],
    aspectRatio !== "auto" && aspectRatioClasses[aspectRatio],
    variantClasses[variant],
    clickable && "cursor-pointer hover:opacity-90 transition-opacity"
  )

  // Handle null/undefined/empty values
  if (value == null || value === "") {
    return <EmptyPlaceholder className={containerClassName} />
  }

  const src = String(value)

  // Basic URL validation
  const isValidUrl =
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:image/") ||
    src.startsWith("/")

  if (!isValidUrl) {
    return <BrokenImagePlaceholder className={containerClassName} />
  }

  if (hasError) {
    return <BrokenImagePlaceholder className={containerClassName} />
  }

  const handleClick = clickable
    ? () => setIsFullscreen(true)
    : undefined

  return (
    <>
      <div className={containerClassName} onClick={handleClick}>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted animate-pulse">
            <div className="w-1/4 h-1/4 rounded-full bg-muted-foreground/20" />
          </div>
        )}
        <img
          src={src}
          alt=""
          className={cn(
            "w-full h-full",
            objectFitClasses[objectFit],
            isLoading && "opacity-0"
          )}
          onError={handleError}
          onLoad={handleLoad}
        />
      </div>

      {/* Fullscreen overlay */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setIsFullscreen(false)}
        >
          <button
            className="absolute top-4 right-4 z-10 rounded-md p-2 text-white/70 transition-all hover:bg-white/10 hover:text-white"
            onClick={() => setIsFullscreen(false)}
            aria-label="Close fullscreen"
          >
            <X className="h-6 w-6" />
          </button>
          <div
            className="flex size-full items-center justify-center p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt=""
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </div>
      )}
    </>
  )
}

export const ImageDisplay = observer(
  ImageDisplayComponent
) as unknown as typeof ImageDisplayComponent & {
  supportedConfig: string[]
}

ImageDisplay.supportedConfig = [
  "size",
  "variant",
  "aspectRatio",
  "objectFit",
  "fallback",
  "clickable",
]
